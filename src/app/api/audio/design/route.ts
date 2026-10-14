import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readJsonBody } from "@/lib/api-security";
import { AudioError, audioConnection, designVoice, saveDesignedVoice } from "@/audio/provider";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("preview"), description: z.string().trim().min(20).max(1000) }).strict(),
    z.object({ action: z.literal("save"), name: z.string().trim().min(2).max(80), description: z.string().trim().min(20).max(1000), generatedVoiceId: z.string().regex(/^[A-Za-z0-9_-]{5,100}$/) }).strict(),
]);
export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req) || await limitRequest("audio-design", 8); if (denied) return denied;
    try {
        const input = schema.safeParse(await readJsonBody(req));
        if (!input.success) return NextResponse.json({ error: "Revisa la descripción y el nombre de la voz." }, { status: 400 });
        const connection = await audioConnection("elevenlabs");
        if (input.data.action === "preview") return NextResponse.json({ previews: await designVoice(connection, input.data.description) });
        return NextResponse.json({ voice: await saveDesignedVoice(connection, input.data.name, input.data.description, input.data.generatedVoiceId) });
    } catch (error) {
        return NextResponse.json({ error: error instanceof AudioError ? error.message : "No se pudo diseñar la voz." }, { status: error instanceof AudioError ? error.status : 500 });
    }
}
