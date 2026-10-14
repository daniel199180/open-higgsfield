"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Copy, ImagePlus, Loader2, Save, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { GalleryImagePicker, type GalleryImage } from "@/components/studio/GalleryImagePicker";
import type { SavedPrompt } from "@/prompts/types";

type Analysis = { title: string; prompt: string; negativePrompt: string; tags: string[]; palette: string[]; mode: "vision" | "local" };

export function PromptLibraryStudio({ onBack }: { onBack: () => void }) {
    const [tab, setTab] = useState<"extract" | "library">("extract");
    const [file, setFile] = useState<File | null>(null);
    const [sourceImage, setSourceImage] = useState<GalleryImage | null>(null);
    const [preview, setPreview] = useState("");
    const [analysis, setAnalysis] = useState<Analysis | null>(null);
    const [title, setTitle] = useState("");
    const [prompt, setPrompt] = useState("");
    const [negativePrompt, setNegativePrompt] = useState("");
    const [tags, setTags] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState<SavedPrompt[]>([]);
    const [query, setQuery] = useState("");

    useEffect(() => {
        return () => { if (preview.startsWith("blob:")) URL.revokeObjectURL(preview); };
    }, [preview]);

    async function chooseFile(next: File | null) {
        setFile(next); setSourceImage(null); setAnalysis(null);
        if (preview.startsWith("blob:")) URL.revokeObjectURL(preview);
        setPreview(next ? URL.createObjectURL(next) : "");
    }

    async function chooseGallery(image: GalleryImage) {
        setSourceImage(image); setFile(null); setAnalysis(null); setPreview(image.url);
    }

    async function analyze() {
        setBusy(true); setError("");
        try {
            let source = file;
            if (!source && sourceImage) {
                const response = await fetch(sourceImage.url, { cache: "no-store" });
                if (!response.ok) throw new Error("No se pudo leer la imagen de la galería.");
                source = new File([await response.blob()], "gallery-reference.jpg", { type: "image/jpeg" });
            }
            if (!source) throw new Error("Sube una imagen o elige una de la galería.");
            const body = new FormData(); body.append("image", source);
            const response = await fetch("/api/style-prompt", { method: "POST", body });
            const data = await response.json() as { analysis?: Analysis; error?: string };
            if (!response.ok || !data.analysis) throw new Error(data.error || "No se pudo extraer el estilo.");
            setAnalysis(data.analysis); setTitle(data.analysis.title); setPrompt(data.analysis.prompt); setNegativePrompt(data.analysis.negativePrompt); setTags(data.analysis.tags.join(", "));
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo extraer el estilo."); }
        finally { setBusy(false); }
    }

    async function loadSaved() {
        try {
            const response = await fetch("/api/prompts", { cache: "no-store" });
            const data = await response.json() as { prompts?: SavedPrompt[]; error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo cargar la biblioteca.");
            setSaved(data.prompts ?? []);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar la biblioteca."); }
    }

    useEffect(() => { if (tab === "library") void loadSaved(); }, [tab]);

    async function save() {
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/prompts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title || "Prompt extraído", prompt, negativePrompt, tags: tags.split(",").map(tag => tag.trim()).filter(Boolean), sourceImageUrl: sourceImage?.url || undefined }) });
            const data = await response.json() as { prompt?: SavedPrompt; error?: string };
            if (!response.ok || !data.prompt) throw new Error(data.error || "No se pudo guardar el prompt.");
            setSaved(current => [data.prompt!, ...current.filter(item => item.id !== data.prompt!.id)]); setTab("library");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar el prompt."); }
        finally { setBusy(false); }
    }

    async function remove(id: string) {
        if (!window.confirm("¿Borrar este prompt de la biblioteca?")) return;
        const response = await fetch(`/api/prompts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (response.ok) setSaved(current => current.filter(item => item.id !== id));
    }

    function applyPrompt(value: string) {
        window.dispatchEvent(new CustomEvent("open-higgsfield:use-prompt", { detail: { prompt: value } }));
    }

    const filtered = useMemo(() => saved.filter(item => !query.trim() || `${item.title} ${item.prompt} ${item.tags.join(" ")}`.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es"))), [saved, query]);

    return <main className="min-h-screen bg-black px-4 pb-24 pt-20 text-white sm:px-8"><div className="mx-auto max-w-6xl">
        <button type="button" onClick={onBack} className="mb-6 inline-flex items-center gap-2 text-sm text-white/60 hover:text-white"><ArrowLeft size={16} /> Volver al estudio</button>
        <header className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><div className="mb-2 flex items-center gap-3 text-[#ff4d4d]"><WandSparkles size={24} /><span className="text-xs font-bold uppercase tracking-[.18em]">Prompt Lab</span></div><h1 className="text-3xl font-semibold">Extraer estilo y guardar prompts</h1><p className="mt-2 max-w-2xl text-sm text-white/50">Analiza una imagen, genera una descripción visual detallada y reutilízala en imágenes o videos.</p></div><div className="flex rounded-xl border border-white/10 bg-[#111] p-1"><button type="button" onClick={() => setTab("extract")} className={`rounded-lg px-3 py-2 text-sm ${tab === "extract" ? "bg-[#c62828] text-white" : "text-white/55"}`}><Sparkles size={14} className="mr-1 inline" />Extraer</button><button type="button" onClick={() => setTab("library")} className={`rounded-lg px-3 py-2 text-sm ${tab === "library" ? "bg-[#c62828] text-white" : "text-white/55"}`}><BookOpen size={14} className="mr-1 inline" />Biblioteca</button></div></header>
        {error && <p role="alert" className="mb-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{error}</p>}
        {tab === "extract" ? <div className="grid gap-5 lg:grid-cols-[minmax(260px,360px)_1fr]">
            <section className="rounded-2xl border border-white/10 bg-[#111] p-4"><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ImagePlus size={16} className="text-[#ff4d4d]" /> Imagen de referencia</h2><label className="flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/20 bg-black/30 p-4 text-center hover:border-[#ff4d4d]/60"><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" onChange={event => void chooseFile(event.target.files?.[0] ?? null)} />{preview ? <img src={preview} alt="Referencia" className="max-h-72 w-full rounded-lg object-contain" /> : <><ImagePlus size={28} className="mb-2 text-white/40" /><span className="text-sm text-white/65">Subir imagen</span><span className="mt-1 text-xs text-white/35">PNG, JPG, WebP o AVIF</span></>}</label><div className="mt-3 flex items-center gap-2"><div className="h-px flex-1 bg-white/10" /><span className="text-[10px] uppercase text-white/35">o</span><div className="h-px flex-1 bg-white/10" /></div><div className="mt-3"><GalleryImagePicker onPick={chooseGallery} label="Elegir de la galería" /></div><button type="button" disabled={busy || (!file && !sourceImage)} onClick={() => void analyze()} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Extraer estilo</button>{analysis && <p className="mt-3 text-xs text-white/40">Análisis {analysis.mode === "vision" ? "multimodal" : "local"}. Puedes editar el resultado antes de guardarlo.</p>}</section>
            <section className="rounded-2xl border border-white/10 bg-[#111] p-5"><h2 className="mb-4 text-sm font-semibold">Prompt detallado</h2><label className="mb-3 block text-xs text-white/50">Título<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Ej. Fotografía editorial oscura" className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm outline-none focus:border-[#ff4d4d]" /></label><label className="mb-3 block text-xs text-white/50">Prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={12} placeholder="El resultado aparecerá aquí…" className="mt-1 w-full resize-y rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm leading-relaxed text-white outline-none focus:border-[#ff4d4d]" /></label><label className="mb-3 block text-xs text-white/50">Prompt negativo<textarea value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} rows={3} className="mt-1 w-full resize-y rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-[#ff4d4d]" /></label><label className="mb-4 block text-xs text-white/50">Etiquetas<span className="mt-1 block text-[11px] text-white/35">Sepáralas con comas</span><input value={tags} onChange={event => setTags(event.target.value)} className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm outline-none focus:border-[#ff4d4d]" /></label><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void save()} disabled={busy || !prompt.trim()} className="inline-flex items-center gap-2 rounded-xl bg-[#c62828] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Save size={15} /> Guardar en biblioteca</button><button type="button" onClick={() => void navigator.clipboard?.writeText(prompt)} disabled={!prompt.trim()} className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/75 disabled:opacity-40"><Copy size={15} /> Copiar prompt</button></div>{analysis?.palette?.length ? <div className="mt-5 flex items-center gap-2"><span className="text-xs text-white/40">Paleta detectada</span>{analysis.palette.map(color => <span key={color} title={color} className="h-6 w-6 rounded-full border border-white/20" style={{ background: color }} />)}</div> : null}</section>
        </div> : <section className="rounded-2xl border border-white/10 bg-[#111] p-5"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Biblioteca de prompts</h2><p className="mt-1 text-xs text-white/45">Guarda estilos consistentes para reutilizarlos en cualquier generación.</p></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar…" className="rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#ff4d4d]" /></div>{filtered.length === 0 ? <p className="rounded-xl border border-dashed border-white/15 p-10 text-center text-sm text-white/45">Aún no hay prompts guardados.</p> : <div className="grid gap-3 md:grid-cols-2">{filtered.map(item => <article key={item.id} className="rounded-xl border border-white/10 bg-black/25 p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="font-semibold">{item.title}</h3><p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-white/65">{item.prompt}</p>{item.tags.length > 0 && <p className="mt-3 text-[11px] text-[#ff6b6b]">{item.tags.map(tag => `#${tag}`).join(" ")}</p>}</div>{item.sourceImageUrl && <img src={item.sourceImageUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />}</div><div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3"><button type="button" onClick={() => applyPrompt(item.prompt)} className="rounded-lg bg-[#c62828] px-3 py-1.5 text-xs font-semibold text-white">Usar en el estudio</button><button type="button" onClick={() => void navigator.clipboard?.writeText(item.prompt)} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70"><Copy size={12} /> Copiar</button><button type="button" onClick={() => void remove(item.id)} aria-label={`Borrar ${item.title}`} className="ml-auto rounded-lg border border-white/10 p-1.5 text-white/45 hover:text-red-300"><Trash2 size={14} /></button></div></article>)}</div>}</section>}
    </div></main>;
}
