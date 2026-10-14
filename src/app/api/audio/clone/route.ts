import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { AudioError, audioConnection, cloneVoice } from "@/audio/provider";
import { audioMime } from "@/workflows/assets";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req) || await limitRequest("audio-clone", 6); if (denied) return denied;
    try {
        const type = req.headers.get("content-type") || "";
        if (!type.startsWith("multipart/form-data;")) throw new AudioError("Adjunta una grabación MP3 o WAV.");
        const bytes = await readLimitedBody(req, 12 * 1024 * 1024);
        const form = await new Request("http://localhost", { method: "POST", headers: { "content-type": type }, body: bytes as BodyInit }).formData();
        const name = String(form.get("name") || "").trim();
        const sample = form.get("sample");
        if (name.length < 2 || name.length > 80 || form.get("consent") !== "true" || !(sample instanceof File) || sample.size > 10 * 1024 * 1024) throw new AudioError("Indica un nombre, acepta la autorización y adjunta hasta 10 MB de audio.");
        const buffer = Buffer.from(await sample.arrayBuffer());
        audioMime(buffer);
        const voice = await cloneVoice(await audioConnection("elevenlabs"), name, buffer);
        return NextResponse.json({ voice });
    } catch (error) {
        return NextResponse.json({ error: error instanceof AudioError ? error.message : error instanceof Error && error.message.startsWith("ERR_BODY") ? "El audio supera el límite permitido." : "No se pudo clonar la voz. Comprueba el archivo y los permisos de la cuenta." }, { status: error instanceof AudioError ? error.status : 400 });
    }
}
