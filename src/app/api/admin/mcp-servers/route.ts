import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readJsonBody, securityError } from "@/lib/api-security";
import { getStoredConnection } from "@/lib/connection-store";
import { createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from "@/lib/mcp-server-store";
import { findCapability } from "@/providers/catalog";
import { recordSecurityEvent } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const serverSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(""),
    enabled: z.boolean().default(true),
    connectionId: z.string().uuid(),
    imageModelIds: z.array(z.string().min(1).max(500)).max(50).default([]),
    videoModelIds: z.array(z.string().min(1).max(500)).max(50).default([]),
    rotateToken: z.boolean().optional(),
}).strict();

async function validateSelection(input: z.infer<typeof serverSchema>) {
    if (!input.imageModelIds.length && !input.videoModelIds.length) throw new Error("ERR_MCP_MODELS_REQUIRED");
    if (new Set(input.imageModelIds).size !== input.imageModelIds.length || new Set(input.videoModelIds).size !== input.videoModelIds.length) {
        throw new Error("ERR_MCP_MODELS_INVALID");
    }
    const connection = await getStoredConnection(input.connectionId);
    if (!connection?.enabled) throw new Error("ERR_MCP_CONNECTION_INVALID");
    const selections = await Promise.all([
        ...input.imageModelIds.map(async (id) => ({ mediaType: "image" as const, capability: await findCapability("image", id) })),
        ...input.videoModelIds.map(async (id) => ({ mediaType: "video" as const, capability: await findCapability("video", id) })),
    ]);
    for (const selected of selections) {
        const capability = selected.capability;
        if (!capability || capability.provider !== connection.provider) throw new Error("ERR_MCP_MODELS_INVALID");
    }
}

export async function GET(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req); if (denied) return denied;
        return NextResponse.json({ servers: await listMcpServers() }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}

export async function POST(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("mcp-servers", 30); if (denied) return denied;
        const parsed = serverSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new Error("ERR_INVALID_BODY");
        await validateSelection(parsed.data);
        const { id, rotateToken, ...values } = parsed.data;
        const result = id
            ? await updateMcpServer(id, { ...values, rotateToken })
            : await createMcpServer(values);
        await recordSecurityEvent(`mcp-server.${id ? "updated" : "created"}:${result.server.id}`);
        return NextResponse.json(result, { status: id ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}

export async function DELETE(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("mcp-servers", 30); if (denied) return denied;
        const id = req.nextUrl.searchParams.get("id") ?? "";
        if (!z.string().uuid().safeParse(id).success) throw new Error("ERR_INVALID_BODY");
        await deleteMcpServer(id);
        await recordSecurityEvent(`mcp-server.deleted:${id}`);
        return NextResponse.json({ ok: true });
    } catch (error) { return securityError(error); }
}
