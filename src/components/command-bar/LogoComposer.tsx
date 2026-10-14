"use client";

/* eslint-disable @next/next/no-img-element -- authenticated local preview */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eraser, ImagePlus, Loader2, Sparkles, VectorSquare, X } from "lucide-react";
import { DesignSystemPill } from "@/components/command-bar/DesignSystemPill";
import { CompanySelect, useCompanySelection } from "@/components/command-bar/CompanySelect";
import { PillPopover } from "@/components/command-bar/PillPopover";
import { StudioModePill, type StudioMode } from "@/components/studio/StudioModePill";
import type { BrandSystem } from "@/social/types";

type LogoMode = "create" | "redraw" | "trace";
type VectorModel = { id: string; name: string; acceptsImage: boolean; maxOutputs: number };

export function LogoComposer({ onModeChange }: { onModeChange: (next: StudioMode) => void }) {
    const [brands, setBrands] = useState<BrandSystem[]>([]);
    const [selectedBrandId, setSelectedBrandId] = useState("");
    const companySelection = useCompanySelection();
    const [brandsLoading, setBrandsLoading] = useState(true);
    const [models, setModels] = useState<VectorModel[]>([]);
    const [catalogMessage, setCatalogMessage] = useState("");
    const [modelId, setModelId] = useState("");
    const [logoMode, setLogoMode] = useState<LogoMode>("create");
    const [prompt, setPrompt] = useState("");
    const [count, setCount] = useState(1);
    const [colors, setColors] = useState(8);
    const [sourceFile, setSourceFile] = useState<File | null>(null);
    const [sourceAssetId, setSourceAssetId] = useState("");
    const [cutoutUrl, setCutoutUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [modeOpen, setModeOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const submissionInFlight = useRef(false);

    const loadBrands = useCallback(async () => {
        try {
            const response = await fetch("/api/social", { cache: "no-store" });
            if (!response.ok) throw new Error();
            const value = await response.json() as { brands?: BrandSystem[] };
            const next = value.brands ?? [];
            setBrands(next);
            setSelectedBrandId(current => {
                const remembered = current || window.localStorage.getItem("open-higgsfield:selected-brand") || "";
                return next.some(brand => brand.id === remembered) ? remembered : "";
            });
        } catch { setError("No se pudieron cargar los sistemas de diseño."); }
        finally { setBrandsLoading(false); }
    }, []);

    useEffect(() => {
        void loadBrands();
        window.addEventListener("open-higgsfield:social-brands-updated", loadBrands);
        return () => window.removeEventListener("open-higgsfield:social-brands-updated", loadBrands);
    }, [loadBrands]);

    useEffect(() => {
        let live = true;
        fetch("/api/social/logos", { cache: "no-store" }).then(async response => {
            if (!response.ok) throw new Error("No se pudo cargar el catálogo de logos.");
            return response.json();
        }).then(value => {
            if (!live) return;
            const available = (value.models ?? []) as VectorModel[];
            const preferred = available.find(item => item.id === "recraft/recraft-v4.1-vector") ?? available.find(item => item.id === "recraft/recraft-v4-vector") ?? available[0];
            setModels(available);
            setModelId(current => current || preferred?.id || "");
            setCatalogMessage(value.message ?? "");
        }).catch(cause => { if (live) setCatalogMessage(cause instanceof Error ? cause.message : "No se pudo cargar el catálogo de logos."); });
        return () => { live = false; };
    }, []);

    const availableModels = models.filter(model => logoMode !== "redraw" || model.acceptsImage);
    const selectedModel = availableModels.find(model => model.id === modelId);
    const needsImage = logoMode !== "create";

    function selectBrand(id: string) {
        setSelectedBrandId(id);
        if (id) window.localStorage.setItem("open-higgsfield:selected-brand", id);
        else window.localStorage.removeItem("open-higgsfield:selected-brand");
    }

    function changeLogoMode(next: LogoMode) {
        setLogoMode(next);
        setModeOpen(false);
        setError("");
        if (next === "create") { setSourceFile(null); setSourceAssetId(""); setCutoutUrl(""); }
        if (next === "redraw" && !models.find(model => model.id === modelId)?.acceptsImage) setModelId(models.find(model => model.acceptsImage)?.id ?? "");
        setCount(1);
    }

    function selectFile(file: File | undefined) {
        if (!file) return;
        if (!/^image\/(png|jpeg|webp|avif)$/.test(file.type) || file.size > 20 * 1024 * 1024) { setError("Sube PNG, JPG, WebP o AVIF de hasta 20 MB."); return; }
        setSourceFile(file);
        setSourceAssetId("");
        setCutoutUrl("");
        setError("");
    }

    async function uploadSource(): Promise<string> {
        if (sourceAssetId) return sourceAssetId;
        if (!sourceFile) throw new Error("Adjunta una imagen del logo.");
        setProgress("Subiendo imagen del logo…");
        const upload = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": sourceFile.type }, body: sourceFile });
        const value = await upload.json() as { asset?: { id: string }; error?: string };
        if (!upload.ok || !value.asset?.id) throw new Error(value.error ?? "No se pudo subir la imagen.");
        setSourceAssetId(value.asset.id);
        return value.asset.id;
    }

    async function removeBackground() {
        if (submissionInFlight.current || (!sourceFile && !sourceAssetId)) return;
        submissionInFlight.current = true; setBusy(true); setError(""); setNotice("");
        try {
            const assetId = await uploadSource();
            setProgress("Quitando fondo con GPT Image de OpenRouter…");
            const response = await fetch("/api/images/remove-background", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ source: { type: "asset", assetId } }) });
            const result = await response.json() as { imageUrl?: string; error?: string };
            if (!response.ok || !result.imageUrl) throw new Error(result.error ?? "No se pudo quitar el fondo.");
            setProgress("Guardando el PNG transparente…");
            const imageResponse = await fetch(result.imageUrl, { cache: "no-store" });
            if (!imageResponse.ok) throw new Error("El fondo se quitó, pero no se pudo recuperar el PNG. El resultado está en la galería de imágenes.");
            const image = await imageResponse.blob();
            const upload = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": "image/png" }, body: image });
            const saved = await upload.json() as { asset?: { id: string }; error?: string };
            if (!upload.ok || !saved.asset?.id) throw new Error(saved.error ?? "El PNG está en la galería de imágenes, pero no se pudo adjuntar al logo.");
            setSourceAssetId(saved.asset.id);
            setSourceFile(null);
            setCutoutUrl(result.imageUrl);
            if (fileInputRef.current) fileInputRef.current.value = "";
            setNotice("Fondo eliminado. Puedes descargar el PNG, vectorizarlo o usarlo para redibujar el logo.");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo quitar el fondo."); }
        finally { submissionInFlight.current = false; setBusy(false); setProgress(""); }
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (submissionInFlight.current) return;
        setError(""); setNotice("");
        if (needsImage && !sourceFile && !sourceAssetId) { setError("Adjunta una imagen del logo."); return; }
        if (logoMode !== "trace" && prompt.trim().length < 10) { setError("Describe el logo con al menos diez caracteres."); return; }
        if (logoMode !== "trace" && !selectedModel) { setError(catalogMessage || "Selecciona un modelo SVG de OpenRouter."); return; }
        submissionInFlight.current = true;
        setBusy(true);
        try {
            const assetId = needsImage ? await uploadSource() : "";
            setProgress(logoMode === "trace" ? "Vectorizando imagen…" : "Generando logo vectorial con OpenRouter…");
            const payload = logoMode === "trace"
                ? { mode: "trace", ...(selectedBrandId ? { brandId: selectedBrandId } : {}), ...(companySelection.selectedId ? { companyId: companySelection.selectedId } : {}), sourceAssetId: assetId, colors }
                : { mode: logoMode, ...(selectedBrandId ? { brandId: selectedBrandId } : {}), ...(companySelection.selectedId ? { companyId: companySelection.selectedId } : {}), modelId: selectedModel!.id, prompt: prompt.trim(), count, ...(logoMode === "redraw" ? { sourceAssetId: assetId } : {}) };
            const response = await fetch("/api/social/logos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? "No se pudo crear el logo.");
            window.dispatchEvent(new CustomEvent("open-higgsfield:logos-updated", { detail: { results: value.results } }));
            setNotice(`${value.results.length} logo${value.results.length === 1 ? " listo" : "s listos"}. Puedes verlo arriba, descargar el SVG o aplicarlo a tu marca.`);
            if (logoMode !== "trace") setPrompt("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudo crear el logo.");
        } finally { submissionInFlight.current = false; setBusy(false); setProgress(""); }
    }

    return <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-4 sm:px-5 sm:pb-5">
        {(error || notice || progress) && <div role={error ? "alert" : "status"} className={`pointer-events-auto mx-auto mb-3 max-w-[70rem] rounded-2xl border px-4 py-3 text-sm shadow-xl ${error ? "border-red-400/25 bg-[#151010] text-red-200" : "border-[#ff4d4d]/25 bg-[#111] text-white/80"}`}>{progress && <Loader2 aria-hidden="true" className="mr-2 inline h-4 w-4 animate-spin text-[#ff4d4d]" />}{error || progress || notice}</div>}
        <form onSubmit={submit} aria-busy={busy} className="pointer-events-auto mx-auto flex max-w-[70rem] flex-col gap-3 rounded-[28px] border border-white/[.08] p-3 text-white shadow-[0_28px_80px_rgba(0,0,0,.42)] backdrop-blur-[26px] sm:flex-row" style={{ background: "radial-gradient(circle at 92% 82%, rgba(255,77,77,.07), transparent 18%), linear-gradient(90deg, rgba(12,12,12,.96), rgba(20,20,20,.92) 52%, rgba(24,24,24,.88))" }}>
            <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                    {needsImage && <><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" aria-label="Imagen del logo" onChange={event => selectFile(event.target.files?.[0])} /><button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} aria-label="Adjuntar imagen del logo" title="Adjuntar imagen del logo" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-white/75 hover:border-[#ff4d4d]/40"><ImagePlus size={18} /></button></>}
                    {logoMode === "trace" ? <div className="min-h-10 flex-1 py-2 text-sm text-white/50">Adjunta una imagen para convertirla en SVG fiel al original.</div> : <textarea aria-label="Describe el logo" rows={2} maxLength={2000} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={logoMode === "redraw" ? "¿Cómo quieres redibujar este logo? Describe los cambios…" : "Describe el logo que quieres crear: nombre, símbolo, estilo y personalidad…"} className="max-h-[35dvh] min-h-12 w-full flex-1 resize-y border-none bg-transparent py-1.5 text-[15px] text-white outline-none placeholder:text-white/35" />}
                </div>
                {needsImage && (sourceFile || sourceAssetId) && <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70">
                    {cutoutUrl ? <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded bg-[linear-gradient(45deg,#333_25%,transparent_25%,transparent_75%,#333_75%),linear-gradient(45deg,#333_25%,transparent_25%,transparent_75%,#333_75%)] bg-[length:12px_12px] bg-[position:0_0,6px_6px]"><img src={cutoutUrl} alt="Logo sin fondo" className="h-full w-full object-contain" /></span> : <ImagePlus size={13} />}
                    <span className="min-w-0 flex-1 truncate">{cutoutUrl ? "Logo con fondo transparente" : sourceFile?.name ?? "Imagen del logo"}</span>
                    {cutoutUrl && <a href={cutoutUrl} download="logo-sin-fondo.png" aria-label="Descargar PNG sin fondo" className="inline-flex items-center gap-1 text-[#ff4d4d]"><Download size={13} />PNG</a>}
                    {!cutoutUrl && <button type="button" disabled={busy} onClick={() => void removeBackground()} className="inline-flex items-center gap-1 rounded-md border border-[#ff4d4d]/30 px-2 py-1 text-[#ff4d4d] disabled:opacity-50"><Eraser size={13} />Quitar fondo con GPT</button>}
                    <button type="button" disabled={busy} aria-label="Quitar imagen" onClick={() => { setSourceFile(null); setSourceAssetId(""); setCutoutUrl(""); if (fileInputRef.current) fileInputRef.current.value = ""; }}><X size={14} /></button>
                </div>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StudioModePill mode="logo" onModeChange={onModeChange} disabled={busy} />
                    <DesignSystemPill brands={brands} selectedId={selectedBrandId} loading={brandsLoading} onSelect={selectBrand} emptyLabel="Sin sistema de diseño" />
                    <CompanySelect companies={companySelection.companies} selectedId={companySelection.selectedId} onSelect={companySelection.select} />
                    <PillPopover open={modeOpen} onOpenChange={setModeOpen} width="w-52" trigger={<><VectorSquare className="h-4 w-4" /><span>{logoMode === "create" ? "Crear con IA" : logoMode === "redraw" ? "Redibujar con IA" : "Vectorizar fiel"}</span></>}><p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-white/45">Función de logo</p>{([ ["create", "Crear con IA"], ["redraw", "Redibujar con IA"], ["trace", "Vectorizar fiel"] ] as const).map(([id, label]) => <button key={id} type="button" disabled={busy} onClick={() => changeLogoMode(id)} className={`block w-full rounded-xl px-3 py-2.5 text-left text-xs ${logoMode === id ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white/70 hover:bg-white/5"}`}>{label}</button>)}</PillPopover>
                    {logoMode === "trace" ? <PillPopover open={optionsOpen} onOpenChange={setOptionsOpen} width="w-60" trigger={<><VectorSquare className="h-4 w-4" /><span>{colors} colores</span></>}><label className="block text-xs text-white/70">Cantidad de colores: {colors}<input type="range" min={2} max={24} value={colors} onChange={event => setColors(Number(event.target.value))} className="mt-3 w-full accent-[#ff4d4d]" /></label><p className="mt-3 text-[11px] leading-5 text-white/45">Vectorización local sin costo de API. Mejor para logos planos.</p></PillPopover> : <><PillPopover open={modelOpen} onOpenChange={setModelOpen} width="w-72" trigger={<><Sparkles className="h-4 w-4" /><span className="max-w-40 truncate">{selectedModel?.name ?? "Elige modelo SVG"}</span></>}><p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-white/45">Modelo vectorial de OpenRouter</p><div className="max-h-64 space-y-1 overflow-y-auto">{availableModels.map(model => <button key={model.id} type="button" disabled={busy} onClick={() => { setModelId(model.id); setCount(1); setModelOpen(false); }} className={`block w-full rounded-xl px-3 py-2 text-left text-xs ${selectedModel?.id === model.id ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white/70 hover:bg-white/5"}`}>{model.name}</button>)}{availableModels.length === 0 && <p className="px-2 text-xs leading-5 text-white/50">{catalogMessage || "No hay modelos SVG disponibles para esta función."}</p>}</div></PillPopover><PillPopover open={optionsOpen} onOpenChange={setOptionsOpen} width="w-48" trigger={<><Sparkles className="h-4 w-4" /><span>{count} {count === 1 ? "propuesta" : "propuestas"}</span></>}><p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-white/45">Cantidad de logos</p><div className="grid grid-cols-4 gap-1">{Array.from({ length: selectedModel?.maxOutputs ?? 1 }, (_, index) => index + 1).map(value => <button key={value} type="button" onClick={() => { setCount(value); setOptionsOpen(false); }} className={`rounded-lg py-2 text-xs ${count === value ? "bg-[#c62828] text-white" : "bg-white/5 text-white/70"}`}>{value}</button>)}</div><p className="mt-3 text-[11px] leading-5 text-white/45">La generación con OpenRouter puede tener costo.</p></PillPopover></>}
                </div>
            </div>
            <button type="submit" disabled={busy} className="flex min-h-14 w-full shrink-0 flex-col items-center justify-center rounded-[22px] bg-[#c62828] px-4 font-bold text-white transition hover:bg-[#e13939] disabled:cursor-wait disabled:opacity-60 sm:min-h-[84px] sm:w-[146px]"><span className="flex items-center gap-2 text-lg">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? "Procesando" : logoMode === "trace" ? "Convertir" : "Generar"}</span><small className="mt-1 text-[10px] font-extrabold uppercase tracking-[.08em]">{logoMode === "trace" ? "SVG" : count === 1 ? "LOGO" : `${count} LOGOS`}</small></button>
        </form>
    </div>;
}
