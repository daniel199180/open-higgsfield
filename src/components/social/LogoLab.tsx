"use client";

import { useEffect, useState } from "react";
import { Download, ImagePlus, Sparkles, VectorSquare } from "lucide-react";
import type { BrandSystem, LogoResult } from "@/social/types";
import { brandLogoAssetIds, brandSaveInput, MAX_BRAND_LOGOS } from "@/social/brand";

/* eslint-disable @next/next/no-img-element -- authenticated local asset previews. */
type Model = { id: string; name: string; acceptsImage: boolean; maxOutputs: number };
type Props = { brands: BrandSystem[]; initialBrandId: string; onBrandUpdated: (brand: BrandSystem) => Promise<void> };

export function LogoLab({ brands, initialBrandId, onBrandUpdated }: Props) {
    const [brandId, setBrandId] = useState(initialBrandId);
    const [mode, setMode] = useState<"create" | "redraw" | "trace">("create");
    const [prompt, setPrompt] = useState("");
    const [sourceAssetId, setSourceAssetId] = useState("");
    const [sourcePreview, setSourcePreview] = useState("");
    const [models, setModels] = useState<Model[]>([]);
    const [modelId, setModelId] = useState("");
    const [count, setCount] = useState(1);
    const [colors, setColors] = useState(8);
    const [results, setResults] = useState<LogoResult[]>([]);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => { if (initialBrandId) setBrandId(initialBrandId); }, [initialBrandId]);
    useEffect(() => {
        let live = true;
        fetch("/api/social/logos", { cache: "no-store" }).then(async response => {
            if (!response.ok) throw new Error("No se pudo cargar Logo Lab.");
            return response.json();
        }).then(value => { if (live) { const available = value.models as Model[] ?? []; const preferred = available.find(item => item.id === "recraft/recraft-v4.1-vector") ?? available.find(item => item.id === "recraft/recraft-v4-vector") ?? available[0]; setResults(value.results ?? []); setModels(available); setMessage(value.message ?? ""); setModelId(current => current || preferred?.id || ""); } }).catch(reason => { if (live) setError(reason.message); });
        return () => { live = false; };
    }, []);

    const availableModels = models.filter(item => mode !== "redraw" || item.acceptsImage);
    const selected = availableModels.find(item => item.id === modelId);
    const visible = results.filter(result => brandId ? result.brandId === brandId : !result.brandId);
    const needImage = mode !== "create";
    async function upload(file: File) {
        setError("");
        if (!/^image\/(png|jpeg|webp|avif)$/.test(file.type) || file.size > 20 * 1024 * 1024) { setError("Sube PNG, JPG, WebP o AVIF de hasta 20 MB."); return; }
        setBusy(true);
        try {
            const response = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": file.type }, body: file });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? "No se pudo subir la imagen.");
            setSourceAssetId(value.asset.id);
            setSourcePreview(`/api/workflows/assets/${value.asset.id}`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo subir la imagen."); }
        finally { setBusy(false); }
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setError(""); setMessage("");
        if (needImage && !sourceAssetId) { setError("Sube la imagen del logo."); return; }
        setBusy(true);
        try {
            const payload = mode === "trace" ? { mode, ...(brandId ? { brandId } : {}), sourceAssetId, colors } : { mode, ...(brandId ? { brandId } : {}), modelId, prompt, count, ...(mode === "redraw" ? { sourceAssetId } : {}) };
            const response = await fetch("/api/social/logos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? "No se pudo crear el logo.");
            setResults(current => [...value.results, ...current]);
            setMessage(`${value.results.length} logo(s) listo(s). Descarga el SVG o úsalo en la marca.`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo crear el logo."); }
        finally { setBusy(false); }
    }

    async function apply(result: LogoResult) {
        const brand = brands.find(item => item.id === result.brandId);
        if (!brand) return;
        setBusy(true); setError("");
        try {
            const logoAssetIds = [...new Set([...brandLogoAssetIds(brand), result.previewAssetId])];
            if (logoAssetIds.length > MAX_BRAND_LOGOS) throw new Error(`Este sistema ya tiene ${MAX_BRAND_LOGOS} logos. Quita uno antes de añadir otro.`);
            const response = await fetch("/api/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save-brand", brand: brandSaveInput({ ...brand, logoAssetIds, logoAssetId: logoAssetIds[0], logoVectorAssetId: result.vectorAssetId }) }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? "No se pudo aplicar el logo.");
            await onBrandUpdated(value.brand);
            window.dispatchEvent(new Event("open-higgsfield:social-brands-updated"));
            setMessage("Logo aplicado al sistema de diseño. Ya está disponible como referencia al generar imágenes.");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo aplicar el logo."); }
        finally { setBusy(false); }
    }

    return <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <form onSubmit={submit} className="h-fit rounded-[28px] border border-white/10 bg-[#0d0d0d] p-5 sm:p-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#ff4d4d]">Logo Lab</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Crea o vectoriza tu logo.</h2>
            <p className="mt-2 text-sm leading-6 text-white/45">SVG editable y PNG de vista previa. La vectorización fiel es local; la creación con IA usa OpenRouter y puede tener costo.</p>
            <label className="mt-6 block text-xs text-white/60">Sistema de diseño (opcional)<select className="mt-2 w-full rounded-xl border border-white/10 bg-[#171717] px-4 py-3 text-sm text-white" value={brandId} onChange={event => setBrandId(event.target.value)}><option value="">Sin sistema de diseño</option>{brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
            <div className="mt-5 grid gap-2 sm:grid-cols-3" role="group" aria-label="Modo de logo">
                {([ ["create", "Crear con IA"], ["redraw", "Redibujar con IA"], ["trace", "Vectorizar fiel"] ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => { setMode(value); if (value === "redraw" && !selected?.acceptsImage) { setModelId(models.find(item => item.acceptsImage)?.id ?? ""); setCount(1); } }} aria-pressed={mode === value} className={`rounded-xl border px-3 py-3 text-xs font-medium transition ${mode === value ? "border-[#ff4d4d] bg-[#ff4d4d]/10 text-[#ff4d4d]" : "border-white/10 text-white/65 hover:border-white/30"}`}>{label}</button>)}
            </div>
            {needImage && <label className="mt-5 block cursor-pointer rounded-2xl border border-dashed border-white/20 p-4 text-sm text-white/65 hover:border-[#ff4d4d]/50"><span className="flex items-center gap-2"><ImagePlus size={17} />{sourceAssetId ? "Cambiar imagen" : "Subir imagen del logo"}</span><span className="mt-1 block text-xs text-white/35">PNG, JPG, WebP o AVIF · hasta 20 MB</span><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="mt-3 block w-full text-xs" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />{sourcePreview && <img src={sourcePreview} alt="Logo original" className="mt-3 h-24 w-24 rounded-xl bg-white object-contain p-2" />}</label>}
            {mode === "trace" ? <><p className="mt-5 text-xs leading-5 text-white/45">Traza formas y colores sin IA ni costo de API. Conviene para logos planos; fotografías, degradados y texto pequeño pueden requerir retoques manuales.</p><label className="mt-4 block text-xs text-white/60">Cantidad de colores: {colors}<input type="range" min={2} max={24} value={colors} onChange={event => setColors(Number(event.target.value))} className="mt-2 w-full accent-[#ff4d4d]" /></label></> : <>
                <label className="mt-5 block text-xs text-white/60">Describe el logo y el estilo<textarea required minLength={10} maxLength={2000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ej. Un isotipo geométrico para una marca de tecnología, simple y memorable…" className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-[#171717] p-4 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#ff4d4d]/60" /></label>
                <label className="mt-4 block text-xs text-white/60">Modelo SVG<select className="mt-2 w-full rounded-xl border border-white/10 bg-[#171717] px-4 py-3 text-sm text-white" value={selected?.id ?? ""} onChange={event => { setModelId(event.target.value); setCount(1); }}><option value="">Selecciona un modelo</option>{availableModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="mt-4 block text-xs text-white/60">Propuestas<select className="mt-2 w-full rounded-xl border border-white/10 bg-[#171717] px-4 py-3 text-sm text-white" value={count} onChange={event => setCount(Number(event.target.value))}>{Array.from({ length: selected?.maxOutputs ?? 1 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label>
                {mode === "redraw" && <p className="mt-3 text-xs leading-5 text-red-200/70">La IA puede cambiar letras, proporciones o detalles. Para conservar el logo original, usa “Vectorizar fiel”.</p>}
                {message && <p className="mt-4 text-xs text-white/45">{message}</p>}
            </>}
            {error && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
            {message && mode === "trace" && <p role="status" className="mt-4 text-xs text-[#ff4d4d]">{message}</p>}
            <button disabled={busy || (mode !== "trace" && !selected)} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-[#ad1f1f] disabled:cursor-not-allowed disabled:opacity-40">{mode === "trace" ? <VectorSquare size={17} /> : <Sparkles size={17} />}{busy ? "Procesando…" : mode === "trace" ? "Convertir a SVG" : `Generar ${count} logo${count > 1 ? "s" : ""}`}</button>
            {message && mode !== "trace" && <p role="status" className="sr-only">{message}</p>}
        </form>
        <section className="min-w-0 rounded-[28px] border border-white/10 bg-[#0d0d0d] p-5 sm:p-7">
            <div className="flex items-end justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#ff4d4d]">Biblioteca vectorial</p><h3 className="mt-2 text-xl font-semibold">Propuestas para tu marca</h3></div><span className="text-xs text-white/40">{visible.length} resultado(s)</span></div>
            {!visible.length ? <div className="mt-6 grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/10 text-center text-sm text-white/35">Tus logos aparecerán aquí.</div> : <div className="mt-6 grid gap-4 sm:grid-cols-2">{visible.map(result => <article key={result.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#141414]"><div className="grid aspect-square place-items-center bg-[linear-gradient(45deg,#242724_25%,transparent_25%,transparent_75%,#242724_75%),linear-gradient(45deg,#242724_25%,transparent_25%,transparent_75%,#242724_75%)] bg-[length:24px_24px] bg-[position:0_0,12px_12px]"><img src={`/api/workflows/assets/${result.previewAssetId}`} alt="Propuesta de logo" className="h-full max-h-80 w-full object-contain p-8" /></div><div className="space-y-3 p-4"><p className="truncate text-xs text-white/50">{result.mode === "trace" ? "Vectorización fiel" : result.mode === "redraw" ? "Redibujado con IA" : "Creado con IA"}{result.modelId ? ` · ${result.modelId}` : ""}</p><div className="flex flex-wrap gap-2"><a href={`/api/workflows/assets/${result.vectorAssetId}?download=1`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 hover:border-[#ff4d4d]/50"><Download size={13} />SVG</a><a href={`/api/workflows/assets/${result.previewAssetId}?download=1`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 hover:border-[#ff4d4d]/50"><Download size={13} />PNG</a>{result.brandId && <button type="button" disabled={busy} onClick={() => void apply(result)} className="rounded-lg bg-[#c62828] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Usar en marca</button>}</div></div></article>)}</div>}
        </section>
    </div>;
}
