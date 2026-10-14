import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { AudioError, audioConnection, elevenModels, openRouterCloneModels, openRouterSpeechModels, speakWithOpenRouter, speakWithReference, speakWithVoice } from "@/audio/provider";
import { getVoice } from "@/audio/store";
import { audioMime } from "@/workflows/assets";
import { requireCompany } from "@/library/server";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req) || await limitRequest("audio-speech", 10); if (denied) return denied;
    try {
        const type = req.headers.get("content-type") || "";
        if (!type.startsWith("multipart/form-data;")) throw new AudioError("Solicitud de audio inválida.");
        const bytes = await readLimitedBody(req, 12 * 1024 * 1024);
        const form = await new Request("http://localhost", { method: "POST", headers: { "content-type": type }, body: bytes as BodyInit }).formData();
        const text = String(form.get("text") || "").trim();
        const model = String(form.get("model") || "");
        const companyId = await requireCompany(String(form.get("companyId") || "") || undefined);
        if (!text || text.length > 3000) throw new AudioError("Escribe entre 1 y 3000 caracteres.");
        let result;
        if (form.get("provider") === "elevenlabs") {
            const voice = await getVoice(String(form.get("voiceId") || ""));
            if (!voice) throw new AudioError("Selecciona una voz guardada.");
            if (voice.requiresVerification) throw new AudioError("Esta voz requiere verificación en ElevenLabs antes de usarla.", 409);
            const connection = await audioConnection("elevenlabs", voice.connectionId);
            const models = await elevenModels(connection);
            if (!models.some(item => item.id === model)) throw new AudioError("El modelo de ElevenLabs no está disponible.");
            result = await speakWithVoice(connection, voice, text, model);
        } else if (form.get("provider") === "openrouter-tts") {
            const voice = String(form.get("voice") || "");
            const connection = await audioConnection("openrouter");
            const selected = (await openRouterSpeechModels(connection)).find(item => item.id === model);
            if (!selected) throw new AudioError("El modelo de locución ya no está disponible en OpenRouter.");
            if (!selected.voices.includes(voice)) throw new AudioError("Selecciona una voz compatible con el modelo elegido.");
            result = await speakWithOpenRouter(connection, text, model, voice);
        } else if (form.get("provider") === "openrouter") {
            if (form.get("consent") !== "true") throw new AudioError("Confirma que tienes autorización para usar esta voz.");
            const sample = form.get("sample");
            if (!(sample instanceof File) || sample.size > 10 * 1024 * 1024) throw new AudioError("Adjunta una muestra MP3 o WAV de hasta 10 MB.");
            const buffer = Buffer.from(await sample.arrayBuffer());
            audioMime(buffer);
            const connection = await audioConnection("openrouter");
            if (!(await openRouterCloneModels(connection)).some(item => item.id === model)) throw new AudioError("Este modelo no admite clonación de voz actualmente.");
            result = await speakWithReference(connection, text, model, buffer);
        } else throw new AudioError("Selecciona un proveedor de audio.");
        if (companyId) {
            result = { ...result, companyId };
            await workflowStore().transaction(docs => { docs.set(`audio:${result.id}`, result); });
        }
        return NextResponse.json({ result });
    } catch (error) {
        return NextResponse.json({ error: error instanceof AudioError || error instanceof WorkflowError ? error.message : error instanceof Error && error.message.startsWith("ERR_BODY") ? "El archivo supera el límite permitido." : "No se pudo generar el audio." }, { status: error instanceof AudioError || error instanceof WorkflowError ? error.status : 400 });
    }
}
