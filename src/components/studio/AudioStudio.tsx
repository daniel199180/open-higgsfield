"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Mic2, Sparkles, Upload } from "lucide-react";
import { StudioModePill, type StudioMode } from "./StudioModePill";
import type { AudioResult, SavedVoice } from "@/audio/types";
import { CompanySelect, useCompanySelection } from "@/components/command-bar/CompanySelect";

type Preview = { generatedVoiceId: string; assetId: string };
type Catalog = { voices: SavedVoice[]; results: AudioResult[]; connections: { elevenlabs: string | null; openrouter: string | null }; elevenModels: Array<{ id: string; name: string }>; cloneModels: Array<{ id: string; name: string }>; routerSpeechModels: Array<{ id: string; name: string; voices: string[] }> };
const initial: Catalog = { voices: [], results: [], connections: { elevenlabs: null, openrouter: null }, elevenModels: [], cloneModels: [], routerSpeechModels: [] };
const selectClass = "rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-sm text-white outline-none focus:border-[#ff4d4d]";

export function AudioStudio({ onModeChange }: { onModeChange: (mode: StudioMode) => void }) {
    const companySelection = useCompanySelection();
    const [catalog, setCatalog] = useState<Catalog>(initial);
    const [action, setAction] = useState<"design" | "clone" | "speak">("speak");
    const [cloneKind, setCloneKind] = useState<"saved" | "quick">("saved");
    const [speechProvider, setSpeechProvider] = useState<"openrouter" | "elevenlabs">("openrouter");
    const [routerVoice, setRouterVoice] = useState("");
    const [description, setDescription] = useState("");
    const [name, setName] = useState("");
    const [text, setText] = useState("");
    const [voiceId, setVoiceId] = useState("");
    const [model, setModel] = useState("");
    const [sample, setSample] = useState<File | null>(null);
    const [consent, setConsent] = useState(false);
    const [previews, setPreviews] = useState<Preview[]>([]);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    const inFlight = useRef(false);

    const refresh = useCallback(async () => {
        const response = await fetch("/api/audio", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No se pudo cargar el estudio de audio.");
        setCatalog(data as Catalog);
        setVoiceId(current => current || data.voices?.[0]?.id || "");
        if (!data.connections.openrouter && data.connections.elevenlabs) setSpeechProvider("elevenlabs");
    }, []);
    useEffect(() => {
        void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "No se pudo cargar audio."));
        window.addEventListener("open-higgsfield:connections-updated", refresh);
        return () => window.removeEventListener("open-higgsfield:connections-updated", refresh);
    }, [refresh]);

    const models = action === "clone" && cloneKind === "quick" ? catalog.cloneModels : action === "speak" && speechProvider === "openrouter" ? catalog.routerSpeechModels : catalog.elevenModels;
    const preferredModel = action === "speak" && speechProvider === "openrouter" ? models.find(item => item.id === "elevenlabs/eleven-v4-turbo") : null;
    const chosenModel = models.some(item => item.id === model) ? model : preferredModel?.id || models[0]?.id || "";
    const currentRouterModel = catalog.routerSpeechModels.find(item => item.id === chosenModel);
    const chosenRouterVoice = currentRouterModel?.voices.includes(routerVoice) ? routerVoice : currentRouterModel?.voices[0] || "";
    const selectedVoice = catalog.voices.find(voice => voice.id === voiceId);
    const canAct = action === "design" ? Boolean(catalog.connections.elevenlabs && description.trim().length >= 20)
        : action === "clone" && cloneKind === "saved" ? Boolean(catalog.connections.elevenlabs && name.trim().length >= 2 && sample && consent)
        : action === "clone" ? Boolean(catalog.connections.openrouter && sample && consent && text.trim() && chosenModel)
        : speechProvider === "openrouter" ? Boolean(catalog.connections.openrouter && chosenModel && chosenRouterVoice && text.trim())
        : Boolean(catalog.connections.elevenlabs && selectedVoice && !selectedVoice.requiresVerification && chosenModel && text.trim());
    const connectionHint = !catalog.connections.elevenlabs && (action === "design" || action === "clone" && cloneKind === "saved")
        ? "Para esta función, añade tu API key de ElevenLabs en Conexiones de APIs."
        : !catalog.connections.openrouter && action === "clone" && cloneKind === "quick"
        ? "Para la prueba rápida, conecta OpenRouter en Conexiones de APIs."
        : !catalog.connections.openrouter && action === "speak" && speechProvider === "openrouter"
        ? "Conecta OpenRouter en Conexiones de APIs para generar locuciones con sus modelos."
        : !catalog.connections.elevenlabs && action === "speak" && speechProvider === "elevenlabs"
        ? "Conecta ElevenLabs en Conexiones de APIs para usar tus voces guardadas."
        : "";

    function chooseFile(file: File | undefined) {
        if (!file) return;
        if (!/\.(mp3|wav)$/i.test(file.name) || file.size > 10 * 1024 * 1024 || file.size === 0) { setError("Sube un MP3 o WAV de hasta 10 MB."); return; }
        setSample(file); setError("");
    }

    async function send(event: React.FormEvent) {
        event.preventDefault();
        if (!canAct || inFlight.current) return;
        inFlight.current = true; setBusy(true); setError(""); setStatus("");
        try {
            let response: Response;
            if (action === "design") {
                setStatus("Diseñando propuestas de voz…");
                response = await fetch("/api/audio/design", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", description: description.trim() }) });
            } else if (action === "clone" && cloneKind === "saved") {
                setStatus("Guardando el clon en ElevenLabs…");
                const form = new FormData(); form.set("name", name.trim()); form.set("consent", String(consent)); form.set("sample", sample!);
                response = await fetch("/api/audio/clone", { method: "POST", body: form });
            } else {
                setStatus("Generando audio…");
                const form = new FormData(); form.set("text", text.trim()); form.set("model", chosenModel);
                if (companySelection.selectedId) form.set("companyId", companySelection.selectedId);
                if (action === "clone") { form.set("provider", "openrouter"); form.set("consent", String(consent)); form.set("sample", sample!); }
                else if (speechProvider === "openrouter") { form.set("provider", "openrouter-tts"); form.set("voice", chosenRouterVoice); }
                else { form.set("provider", "elevenlabs"); form.set("voiceId", voiceId); }
                response = await fetch("/api/audio/speech", { method: "POST", body: form });
            }
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
            if (action === "design") { setPreviews(data.previews || []); setStatus("Escucha las propuestas y guarda la que prefieras."); }
            else { await refresh(); setStatus(action === "clone" && cloneKind === "saved" ? data.voice?.requiresVerification ? "Clon guardado. ElevenLabs exige verificar esta voz en tu cuenta antes de usarla." : "Clon guardado. Ya puedes generar locuciones con esta voz." : "Audio listo para escuchar y descargar."); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Error de audio."); setStatus(""); }
        finally { inFlight.current = false; setBusy(false); }
    }

    async function savePreview(preview: Preview) {
        if (inFlight.current) return;
        const voiceName = name.trim();
        if (voiceName.length < 2) { setError("Escribe un nombre para guardar la voz."); return; }
        inFlight.current = true; setBusy(true); setError(""); setStatus("Guardando voz diseñada…");
        try {
            const response = await fetch("/api/audio/design", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", name: voiceName, description: description.trim(), generatedVoiceId: preview.generatedVoiceId }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo guardar la voz.");
            await refresh(); setVoiceId(data.voice.id); setPreviews([]); setAction("speak"); setStatus("Voz guardada. Ya puedes escribir una locución.");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar."); setStatus(""); }
        finally { inFlight.current = false; setBusy(false); }
    }

    return <div className="h-full overflow-y-auto pb-[290px] text-white">
        <div className="mx-auto max-w-[1060px] px-5 pt-20">
            <header className="mb-8 flex items-center gap-3"><Mic2 className="h-7 w-7 text-[#ff4d4d]" /><div><h1 className="text-2xl font-semibold">Estudio de audio</h1><p className="text-sm text-white/45">Diseña voces, clona una voz autorizada y crea locuciones.</p></div></header>
            {!catalog.connections.elevenlabs && !catalog.connections.openrouter && <p className="mb-5 rounded-xl border border-[#ff4d4d]/30 bg-[#ff4d4d]/5 p-4 text-sm text-red-200">Configura OpenRouter o ElevenLabs en «Conexiones de APIs» para comenzar.</p>}
            {previews.length > 0 && <section className="mb-8"><h2 className="mb-3 font-semibold">Propuestas para «{description}»</h2><div className="grid gap-3 sm:grid-cols-2">{previews.map((preview, index) => <article key={preview.generatedVoiceId} className="rounded-2xl border border-white/10 bg-[#111] p-4"><p className="mb-3 text-sm text-white/65">Propuesta {index + 1}</p><audio controls preload="none" src={`/api/workflows/assets/${preview.assetId}`} className="w-full" /><button type="button" disabled={busy} onClick={() => void savePreview(preview)} className="mt-3 rounded-xl bg-[#c62828] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">Guardar esta voz</button></article>)}</div></section>}
            {catalog.voices.length > 0 && <section className="mb-8"><h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/45">Mis voces</h2><div className="flex flex-wrap gap-2">{catalog.voices.map(voice => <button type="button" key={voice.id} onClick={() => { setVoiceId(voice.id); setAction("speak"); }} className={`rounded-xl border px-3 py-2 text-sm ${voice.id === voiceId ? "border-[#ff4d4d]/60 bg-[#ff4d4d]/10" : "border-white/10 bg-[#111]"}`}>{voice.name} <span className="text-xs text-white/45">· {voice.requiresVerification ? "Requiere verificación" : voice.origin === "cloned" ? "Clonada" : "Diseñada"}</span></button>)}</div></section>}
            <section aria-label="Audios generados"><h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/45">Generaciones</h2>{catalog.results.length === 0 ? <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-white/35">Tus audios aparecerán aquí.</p> : <div className="grid gap-3 sm:grid-cols-2">{catalog.results.map(result => <article key={result.id} className="rounded-2xl border border-white/10 bg-[#111] p-4"><p className="mb-1 text-sm font-semibold">{result.voiceName}</p><p className="mb-3 line-clamp-2 text-xs text-white/55">{result.text}</p><audio controls preload="none" src={`/api/workflows/assets/${result.assetId}`} className="w-full" /><div className="mt-3 flex justify-between text-xs text-white/45"><span>{result.provider} · {result.model}</span><a href={`/api/workflows/assets/${result.assetId}?download=1`} className="inline-flex items-center gap-1 text-white/75 hover:text-[#ff4d4d]"><Download size={14} />Descargar</a></div></article>)}</div>}</section>
        </div>
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-4 sm:px-5 sm:pb-5">
            <form onSubmit={send} aria-busy={busy} className="pointer-events-auto mx-auto max-w-[70rem] rounded-[28px] border border-white/10 bg-[#111]/95 p-4 shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex flex-wrap items-center gap-2"><StudioModePill mode="audio" onModeChange={onModeChange} disabled={busy} /><CompanySelect companies={companySelection.companies} selectedId={companySelection.selectedId} onSelect={companySelection.select} />{([ ["design", "Crear voz"], ["clone", "Clonar voz"], ["speak", "Generar locución"] ] as const).map(([id, label]) => <button key={id} type="button" disabled={busy} onClick={() => { setAction(id); setError(""); setStatus(""); }} className={`rounded-xl border px-3 py-2 text-xs font-semibold ${action === id ? "border-[#ff4d4d]/60 bg-[#ff4d4d]/10 text-white" : "border-white/10 text-white/55"}`}>{label}</button>)}</div>
                {action === "speak" && <div className="mb-3 flex gap-2 text-xs"><button type="button" disabled={busy} onClick={() => { setSpeechProvider("openrouter"); setModel(""); }} className={`rounded-lg px-3 py-2 ${speechProvider === "openrouter" ? "bg-white/10" : "text-white/50"}`}>OpenRouter</button><button type="button" disabled={busy} onClick={() => { setSpeechProvider("elevenlabs"); setModel(""); }} className={`rounded-lg px-3 py-2 ${speechProvider === "elevenlabs" ? "bg-white/10" : "text-white/50"}`}>ElevenLabs directo</button></div>}
                {action === "clone" && <div className="mb-3 flex gap-2 text-xs"><button type="button" onClick={() => setCloneKind("saved")} className={`rounded-lg px-3 py-2 ${cloneKind === "saved" ? "bg-white/10" : "text-white/50"}`}>Guardar clon · ElevenLabs</button><button type="button" onClick={() => setCloneKind("quick")} className={`rounded-lg px-3 py-2 ${cloneKind === "quick" ? "bg-white/10" : "text-white/50"}`}>Prueba rápida · OpenRouter</button></div>}
                {action === "design" ? <textarea aria-label="Describe la voz" rows={2} minLength={20} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Describe la voz que quieres crear: idioma, acento, edad aparente, tono, ritmo…" className="max-h-[25dvh] min-h-12 w-full resize-y bg-transparent text-sm outline-none placeholder:text-white/35" /> : action === "clone" && cloneKind === "saved" ? <input aria-label="Nombre del clon" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Nombre de la voz clonada" className="mb-3 w-full bg-transparent p-2 text-sm outline-none placeholder:text-white/35" /> : <textarea aria-label="Texto de la locución" rows={2} maxLength={3000} value={text} onChange={event => setText(event.target.value)} placeholder="Escribe el texto que la voz debe decir…" className="max-h-[25dvh] min-h-12 w-full resize-y bg-transparent text-sm outline-none placeholder:text-white/35" />}
                {action === "design" && previews.length > 0 && <input aria-label="Nombre de la voz" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Nombre para guardar la voz" className="mb-3 w-full rounded-xl border border-white/10 bg-[#191919] p-2 text-sm outline-none" />}
                {action === "speak" && speechProvider === "elevenlabs" && <select aria-label="Voz" value={voiceId} onChange={event => setVoiceId(event.target.value)} className={`${selectClass} mb-3 w-full`}><option value="">Selecciona una voz guardada</option>{catalog.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select>}
                {action === "clone" && <div className="mb-3 flex flex-wrap items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-xs"><Upload size={15} />{sample ? sample.name : "Adjuntar MP3/WAV"}<input type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className="sr-only" onChange={event => chooseFile(event.target.files?.[0])} /></label><label className="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Tengo derechos y consentimiento para clonar esta voz.</label></div>}
                {(action === "speak" || action === "clone" && cloneKind === "quick") && <select aria-label="Modelo de audio" value={chosenModel} onChange={event => setModel(event.target.value)} className={`${selectClass} mb-3 w-full`}>{models.length === 0 && <option value="">Sin modelos disponibles</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
                {action === "speak" && speechProvider === "openrouter" && <select aria-label="Voz de OpenRouter" value={chosenRouterVoice} onChange={event => setRouterVoice(event.target.value)} className={`${selectClass} mb-3 w-full`}>{!currentRouterModel && <option value="">Selecciona un modelo</option>}{currentRouterModel?.voices.map(voice => <option key={voice} value={voice}>{voice}</option>)}</select>}
                <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1">{error && <p role="alert" className="text-xs text-red-300">{error}</p>}{status && <p role="status" className="text-xs text-white/60">{status}</p>}{!error && !status && <p className={`text-xs ${connectionHint ? "text-red-300" : "text-white/35"}`}>{connectionHint || "Las muestras de voz se envían al proveedor elegido; los resultados quedan privados en este servidor."}</p>}</div><button type="submit" disabled={!canAct || busy} className="inline-flex items-center gap-2 rounded-2xl bg-[#c62828] px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{busy ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />}{action === "design" ? "Crear propuestas" : action === "clone" && cloneKind === "saved" ? "Guardar clon" : "Generar audio"}</button></div>
            </form>
        </div>
    </div>;
}
