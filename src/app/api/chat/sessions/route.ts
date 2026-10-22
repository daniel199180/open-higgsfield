import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, readLimitedBody } from "@/lib/api-security";
import { createChatSession, listChatSessions } from "@/chat/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const command = z.object({ modelId: z.string().trim().max(400).optional(), webSearch: z.boolean().optional(), reasoning: z.boolean().optional(), skillId: z.string().trim().max(80).optional() }).strict();

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try { return NextResponse.json({ sessions: await listChatSessions() }, { headers: { "Cache-Control": "private, no-store" } }); }
    catch { return NextResponse.json({ error: "No se pudo cargar el historial." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const raw = req.headers.get("content-type")?.startsWith("application/json")
            ? JSON.parse(Buffer.from(await readLimitedBody(req, 4096)).toString("utf8"))
            : {};
        const input = command.parse(raw);
        return NextResponse.json({ session: await createChatSession(input.modelId, { webSearch: input.webSearch, reasoning: input.reasoning, skillId: input.skillId }) }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ error: error instanceof z.ZodError ? "La sesión no es válida." : "No se pudo crear la sesión." }, { status: 400 });
    }
}
