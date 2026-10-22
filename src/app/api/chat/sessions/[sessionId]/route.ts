import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveChatSession, getChatSession, renameChatSession, updateChatSessionModel, updateChatSessionSettings } from "@/chat/store";
import { authorizeRequest, readLimitedBody } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const command = z.object({ title: z.string().trim().min(1).max(120).optional(), modelId: z.string().trim().max(400).optional(), webSearch: z.boolean().optional(), reasoning: z.boolean().optional(), skillId: z.string().trim().max(80).optional() }).strict();

export async function GET(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { sessionId } = await params;
    if (!idSchema.safeParse(sessionId).success) return NextResponse.json({ error: "Sesión inválida." }, { status: 400 });
    const session = await getChatSession(sessionId);
    return session ? NextResponse.json({ session }, { headers: { "Cache-Control": "private, no-store" } }) : NextResponse.json({ error: "Sesión no encontrada." }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { sessionId } = await params;
    if (!idSchema.safeParse(sessionId).success) return NextResponse.json({ error: "Sesión inválida." }, { status: 400 });
    try {
        const input = command.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 4096)).toString("utf8")));
        let session = input.title !== undefined ? await renameChatSession(sessionId, input.title) : input.modelId !== undefined ? await updateChatSessionModel(sessionId, input.modelId) : null;
        if (!session && (input.webSearch !== undefined || input.reasoning !== undefined || input.skillId !== undefined)) session = await updateChatSessionSettings(sessionId, input);
        return session ? NextResponse.json({ session }) : NextResponse.json({ error: "Sesión no encontrada." }, { status: 404 });
    } catch (error) {
        return NextResponse.json({ error: error instanceof z.ZodError ? "Los datos de la sesión no son válidos." : "No se pudo actualizar la sesión." }, { status: 400 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { sessionId } = await params;
    if (!idSchema.safeParse(sessionId).success) return NextResponse.json({ error: "Sesión inválida." }, { status: 400 });
    return NextResponse.json({ ok: await archiveChatSession(sessionId) });
}
