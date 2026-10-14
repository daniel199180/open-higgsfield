import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { listAudio } from "@/audio/store";
import { audioConnection, elevenModels, openRouterCloneModels, openRouterSpeechModels, refreshVoiceVerification } from "@/audio/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const saved = await listAudio();
        saved.voices = await Promise.all(saved.voices.map(voice => refreshVoiceVerification(voice).catch(() => voice)));
        const [eleven, router] = await Promise.all([
            audioConnection("elevenlabs").catch(() => null),
            audioConnection("openrouter").catch(() => null),
        ]);
        const [elevenModelsList, cloneModels, routerSpeechModels] = await Promise.all([
            eleven ? elevenModels(eleven).catch(() => []) : Promise.resolve([]),
            router ? openRouterCloneModels(router).catch(() => []) : Promise.resolve([]),
            router ? openRouterSpeechModels(router).catch(() => []) : Promise.resolve([]),
        ]);
        return NextResponse.json({ ...saved, connections: { elevenlabs: eleven?.id ?? null, openrouter: router?.id ?? null }, elevenModels: elevenModelsList, cloneModels, routerSpeechModels }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ error: "No se pudo cargar el estudio de audio." }, { status: 500 });
    }
}
