import "server-only";
import crypto from "node:crypto";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { providerFetch } from "@/providers/secure-fetch";
import { billingStore } from "@/billing/store";
import { saveAudioAsset } from "@/workflows/assets";
import { getPreview, saveAudioResult, savePreview, saveVoice } from "./store";
import type { AudioResult, SavedVoice } from "./types";

export class AudioError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

export async function audioConnection(provider: "openrouter" | "elevenlabs", id?: string) {
    const connection = await getConnectionForProvider(provider, id);
    if (!connection) throw new AudioError(`Configura una conexión de ${provider === "openrouter" ? "OpenRouter" : "ElevenLabs"} en Conexiones de APIs.`, 422);
    return connection;
}

export async function refreshVoiceVerification(voice: SavedVoice): Promise<SavedVoice> {
    if (!voice.requiresVerification) return voice;
    const connection = await audioConnection("elevenlabs", voice.connectionId);
    const response = await providerFetch("elevenlabs", `/v1/voices/${encodeURIComponent(voice.providerVoiceId)}`, { headers: headers(connection), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return voice;
    const data = await response.json() as { voice_verification?: { is_verified?: boolean; requires_verification?: boolean } };
    if (data.voice_verification?.is_verified === true || data.voice_verification?.requires_verification === false) {
        const updated = { ...voice, requiresVerification: false };
        await saveVoice(updated);
        return updated;
    }
    return voice;
}

function headers(connection: ProviderConnection): Record<string, string> {
    return connection.provider === "elevenlabs"
        ? { "xi-api-key": connection.credentials.apiKey }
        : { Authorization: `Bearer ${connection.credentials.apiKey}` };
}

async function jsonResponse(response: Response, provider: string): Promise<Record<string, unknown>> {
    if (!response.ok) throw new AudioError(`${provider} rechazó la solicitud (${response.status}). Comprueba permisos, créditos y campos.`, response.status === 429 ? 429 : 422);
    return await response.json() as Record<string, unknown>;
}

export async function elevenModels(connection: ProviderConnection): Promise<Array<{ id: string; name: string }>> {
    const response = await providerFetch("elevenlabs", "/v1/models", { headers: headers(connection), signal: AbortSignal.timeout(15_000) });
    const raw = await jsonResponse(response, "ElevenLabs") as unknown;
    return (Array.isArray(raw) ? raw : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
        .filter(item => item.can_do_text_to_speech === true && typeof item.model_id === "string")
        .map(item => ({ id: String(item.model_id), name: String(item.name || item.model_id) }));
}

export async function openRouterCloneModels(connection: ProviderConnection): Promise<Array<{ id: string; name: string }>> {
    const candidates = ["fish-audio/s2.1-pro", "bytedance-seed/seed-audio-1-0"];
    const responses = await Promise.all(candidates.map(async id => {
        const response = await providerFetch("openrouter", `/api/v1/models/${id}/endpoints`, { headers: headers(connection), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return null;
        const value = await response.json() as { data?: { endpoints?: Array<{ supports_voice_cloning?: boolean }> } };
        return value.data?.endpoints?.some(endpoint => endpoint.supports_voice_cloning) ? { id, name: id.startsWith("fish-") ? "Fish Audio S2.1 Pro" : "Seed Audio 1.0" } : null;
    }));
    return responses.filter((item): item is { id: string; name: string } => item !== null);
}

export interface OpenRouterSpeechModel { id: string; name: string; voices: string[] }

export async function openRouterSpeechModels(connection: ProviderConnection): Promise<OpenRouterSpeechModel[]> {
    const response = await providerFetch("openrouter", "/api/v1/models?output_modalities=speech", {
        headers: headers(connection), signal: AbortSignal.timeout(15_000),
    });
    const raw = await jsonResponse(response, "OpenRouter") as { data?: unknown };
    if (!Array.isArray(raw.data)) throw new AudioError("OpenRouter no devolvió un catálogo de voces válido.", 502);
    return raw.data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
        .filter(item => typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.supported_voices))
        .map(item => ({
            id: String(item.id), name: String(item.name),
            voices: (item.supported_voices as unknown[]).filter((voice): voice is string => typeof voice === "string" && voice.length > 0 && voice.length <= 120),
        }))
        .filter(item => item.voices.length > 0);
}

async function tracked<T>(connection: ProviderConnection, model: string, label: string, fn: () => Promise<T>, tracking?: { id: string; source: "studio" | "workflow" }): Promise<T> {
    const id = tracking?.id ?? `studio:${crypto.randomUUID()}`;
    await billingStore().begin({ id, provider: connection.provider, connection: connection.id, model, label, media: "audio", source: tracking?.source ?? "studio", created: new Date().toISOString(), status: "SUBMITTING" });
    try {
        const value = await fn();
        await billingStore().update(id, "COMPLETED");
        return value;
    } catch (error) {
        await billingStore().update(id, "UNCONFIRMED").catch(() => undefined);
        throw error;
    }
}

export async function designVoice(connection: ProviderConnection, description: string) {
    return tracked(connection, "eleven_ttv_v3", "Diseño de voz", async () => {
        const response = await providerFetch("elevenlabs", "/v1/text-to-voice/design", {
            method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
            body: JSON.stringify({ voice_description: description, model_id: "eleven_ttv_v3", auto_generate_text: true }),
        });
        const data = await jsonResponse(response, "ElevenLabs") as { previews?: Array<{ generated_voice_id?: string; audio_base_64?: string; media_type?: string }> };
        if (!Array.isArray(data.previews) || data.previews.length === 0) throw new AudioError("ElevenLabs no devolvió propuestas de voz.", 502);
        const previews = [];
        for (const preview of data.previews.slice(0, 4)) {
            if (!preview.generated_voice_id || !preview.audio_base_64 || !/^[A-Za-z0-9+/=]+$/.test(preview.audio_base_64)) continue;
            const asset = await saveAudioAsset(Buffer.from(preview.audio_base_64, "base64"));
            await savePreview({ id: preview.generated_voice_id, connectionId: connection.id, description, createdAt: new Date().toISOString() });
            previews.push({ generatedVoiceId: preview.generated_voice_id, assetId: asset.id });
        }
        if (!previews.length) throw new AudioError("Las muestras de voz no tenían un formato válido.", 502);
        return previews;
    });
}

export async function saveDesignedVoice(connection: ProviderConnection, name: string, description: string, generatedVoiceId: string): Promise<SavedVoice> {
    const preview = await getPreview(generatedVoiceId);
    if (!preview || preview.connectionId !== connection.id || preview.description !== description || Date.now() - Date.parse(preview.createdAt) > 60 * 60_000) throw new AudioError("Esta propuesta caducó o no pertenece a esta conexión. Genera nuevas muestras.", 409);
    return tracked(connection, "voice-design-save", "Guardar voz diseñada", async () => {
        const response = await providerFetch("elevenlabs", "/v1/text-to-voice", {
            method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
            body: JSON.stringify({ voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId }),
        });
        const data = await jsonResponse(response, "ElevenLabs");
        if (typeof data.voice_id !== "string") throw new AudioError("ElevenLabs no confirmó la voz guardada.", 502);
        const voice: SavedVoice = { id: crypto.randomUUID(), provider: "elevenlabs", connectionId: connection.id, providerVoiceId: data.voice_id, name, origin: "designed", description, createdAt: new Date().toISOString() };
        await saveVoice(voice);
        return voice;
    });
}

export async function cloneVoice(connection: ProviderConnection, name: string, sample: Buffer): Promise<SavedVoice> {
    return tracked(connection, "instant-voice-clone", "Clonación de voz", async () => {
        const body = new FormData();
        body.set("name", name);
        const wav = sample.subarray(0, 4).toString("ascii") === "RIFF";
        body.append("files", new Blob([new Uint8Array(sample)], { type: wav ? "audio/wav" : "audio/mpeg" }), wav ? "sample.wav" : "sample.mp3");
        const response = await providerFetch("elevenlabs", "/v1/voices/add", { method: "POST", headers: headers(connection), body });
        const data = await jsonResponse(response, "ElevenLabs");
        if (typeof data.voice_id !== "string") throw new AudioError("ElevenLabs no confirmó el clon.", 502);
        const voice: SavedVoice = { id: crypto.randomUUID(), provider: "elevenlabs", connectionId: connection.id, providerVoiceId: data.voice_id, name, origin: "cloned", requiresVerification: data.requires_verification === true, createdAt: new Date().toISOString() };
        await saveVoice(voice);
        return voice;
    });
}

async function audioBytes(response: Response, provider: string): Promise<Buffer> {
    if (!response.ok) throw new AudioError(`${provider} no pudo generar el audio (${response.status}). Comprueba el modelo, los créditos y la muestra.`, response.status === 429 ? 429 : 422);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 20 * 1024 * 1024) throw new AudioError("El audio generado supera 20 MB.", 502);
    const reader = response.body?.getReader();
    if (!reader) throw new AudioError("El proveedor no devolvió audio.", 502);
    const parts: Uint8Array[] = []; let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > 20 * 1024 * 1024) { await reader.cancel(); throw new AudioError("El audio generado supera 20 MB.", 502); }
            parts.push(value);
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(parts, total);
}

export async function speakWithVoice(connection: ProviderConnection, voice: SavedVoice, text: string, model: string, tracking?: { id: string; source: "studio" | "workflow" }): Promise<AudioResult> {
    return tracked(connection, model, "Locución ElevenLabs", async () => {
        const response = await providerFetch("elevenlabs", `/v1/text-to-speech/${encodeURIComponent(voice.providerVoiceId)}?output_format=mp3_44100_128`, {
            method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
            body: JSON.stringify({ text, model_id: model }),
        });
        const asset = await saveAudioAsset(await audioBytes(response, "ElevenLabs"));
        const result: AudioResult = { id: crypto.randomUUID(), provider: "elevenlabs", connectionId: connection.id, model, text, assetId: asset.id, voiceName: voice.name, createdAt: new Date().toISOString() };
        await saveAudioResult(result);
        return result;
    }, tracking);
}

export async function speakWithReference(connection: ProviderConnection, text: string, model: string, sample: Buffer): Promise<AudioResult> {
    return tracked(connection, model, "Clonación rápida OpenRouter", async () => {
        const mime = sample.subarray(0, 4).toString("ascii") === "RIFF" ? "audio/wav" : "audio/mpeg";
        const response = await providerFetch("openrouter", "/api/v1/audio/speech", {
            method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: text, response_format: "mp3", input_references: [{ type: "input_audio", input_audio: { data: `data:${mime};base64,${sample.toString("base64")}` } }] }),
        });
        const asset = await saveAudioAsset(await audioBytes(response, "OpenRouter"));
        const result: AudioResult = { id: crypto.randomUUID(), provider: "openrouter", connectionId: connection.id, model, text, assetId: asset.id, voiceName: "Muestra de voz", createdAt: new Date().toISOString() };
        await saveAudioResult(result);
        return result;
    });
}

export async function speakWithOpenRouter(connection: ProviderConnection, text: string, model: string, voice: string): Promise<AudioResult> {
    return tracked(connection, model, "Locución OpenRouter", async () => {
        const response = await providerFetch("openrouter", "/api/v1/audio/speech", {
            method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
        });
        const asset = await saveAudioAsset(await audioBytes(response, "OpenRouter"));
        const result: AudioResult = { id: crypto.randomUUID(), provider: "openrouter", connectionId: connection.id, model, text, assetId: asset.id, voiceName: voice, createdAt: new Date().toISOString() };
        await saveAudioResult(result);
        return result;
    });
}
