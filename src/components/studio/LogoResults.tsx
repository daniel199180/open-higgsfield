"use client";

/* eslint-disable @next/next/no-img-element -- authenticated local asset previews */
import { useCallback, useEffect, useState } from "react";
import { Download, VectorSquare } from "lucide-react";
import type { BrandSystem, LogoResult } from "@/social/types";
import { brandLogoAssetIds, brandSaveInput, MAX_BRAND_LOGOS } from "@/social/brand";

export function LogoResults() {
    const [results, setResults] = useState<LogoResult[]>([]);
    const [brands, setBrands] = useState<BrandSystem[]>([]);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [applyingId, setApplyingId] = useState("");

    const refresh = useCallback(async () => {
        try {
            const [logosResponse, socialResponse] = await Promise.all([
                fetch("/api/social/logos", { cache: "no-store" }),
                fetch("/api/social", { cache: "no-store" }),
            ]);
            if (!logosResponse.ok || !socialResponse.ok) throw new Error("No se pudo cargar la biblioteca de logos.");
            const logos = await logosResponse.json() as { results?: LogoResult[] };
            const social = await socialResponse.json() as { brands?: BrandSystem[] };
            setResults(logos.results ?? []);
            setBrands(social.brands ?? []);
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudo cargar la biblioteca de logos.");
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => { void refresh(); }, 0);
        const onUpdated = (event: Event) => {
            const created = (event as CustomEvent<{ results?: LogoResult[] }>).detail?.results;
            if (Array.isArray(created)) setResults(current => [...created, ...current.filter(item => !created.some(newItem => newItem.id === item.id))]);
            void refresh();
        };
        window.addEventListener("open-higgsfield:logos-updated", onUpdated);
        return () => { window.clearTimeout(timer); window.removeEventListener("open-higgsfield:logos-updated", onUpdated); };
    }, [refresh]);

    async function apply(result: LogoResult, brandId: string) {
        const brand = brands.find(item => item.id === brandId);
        if (!brand) { setError("El sistema de diseño de este logo ya no está disponible."); return; }
        setApplyingId(result.id); setError(""); setMessage("");
        try {
            const logoAssetIds = [...new Set([...brandLogoAssetIds(brand), result.previewAssetId])];
            if (logoAssetIds.length > MAX_BRAND_LOGOS) throw new Error(`Este sistema ya tiene ${MAX_BRAND_LOGOS} logos. Quita uno antes de añadir otro.`);
            const response = await fetch("/api/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save-brand", brand: brandSaveInput({ ...brand, logoAssetIds, logoAssetId: logoAssetIds[0], logoVectorAssetId: result.vectorAssetId }) }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? "No se pudo aplicar el logo.");
            setBrands(current => current.map(item => item.id === brand.id ? value.brand : item));
            window.dispatchEvent(new Event("open-higgsfield:social-brands-updated"));
            setMessage(`Logo aplicado a ${brand.name}.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudo aplicar el logo.");
        } finally { setApplyingId(""); }
    }

    return <div className="h-full overflow-y-auto pb-[250px] text-white">
        <div className="mx-auto max-w-[1300px] px-5 pt-20">
            <div className="mb-7 flex items-center gap-3"><VectorSquare className="h-6 w-6 text-[#ff4d4d]" /><div><h1 className="text-xl font-semibold">Logos</h1><p className="text-xs text-white/45">Describe tu logo o adjunta una imagen en el cuadro de abajo. Tus propuestas aparecerán aquí.</p></div></div>
            {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/25 p-3 text-xs text-red-200">{error}</p>}
            {message && <p role="status" className="mb-4 rounded-xl border border-[#ff4d4d]/25 p-3 text-xs text-[#ff4d4d]">{message}</p>}
            {results.length === 0 ? <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-white/10 text-center text-sm text-white/40">Aún no hay logos. Escribe tu idea para crear el primero, con o sin sistema de diseño.</div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{results.map(result => {
                const brand = brands.find(item => item.id === result.brandId);
                return <article key={result.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#101010]">
                    <div className="grid aspect-square place-items-center bg-[linear-gradient(45deg,#242424_25%,transparent_25%,transparent_75%,#242424_75%),linear-gradient(45deg,#242424_25%,transparent_25%,transparent_75%,#242424_75%)] bg-[length:24px_24px] bg-[position:0_0,12px_12px]"><img src={`/api/workflows/assets/${result.previewAssetId}`} alt={`Logo ${brand ? `para ${brand.name}` : "sin sistema de diseño"}`} className="h-full max-h-80 w-full object-contain p-8" /></div>
                    <div className="space-y-3 p-4"><p className="truncate text-sm font-semibold">{brand?.name ?? "Sin sistema de diseño"}</p><p className="truncate text-xs text-white/45">{result.mode === "trace" ? "Vectorización fiel" : result.mode === "redraw" ? "Redibujado con IA" : "Creado con IA"}{result.modelId ? ` · ${result.modelId}` : ""}</p>{result.mode !== "trace" && <p className="line-clamp-2 text-xs leading-5 text-white/55">{result.prompt}</p>}
                        <div className="flex flex-wrap gap-2"><a href={`/api/workflows/assets/${result.vectorAssetId}?download=1`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 hover:border-[#ff4d4d]/50"><Download size={13} />SVG</a><a href={`/api/workflows/assets/${result.previewAssetId}?download=1`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 hover:border-[#ff4d4d]/50"><Download size={13} />PNG</a>{brand ? <button type="button" disabled={Boolean(applyingId)} onClick={() => void apply(result, brand.id)} className="rounded-lg bg-[#c62828] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{applyingId === result.id ? "Aplicando…" : "Usar en marca"}</button> : brands.length > 0 && <select aria-label="Añadir logo a un sistema de diseño" defaultValue="" disabled={Boolean(applyingId)} onChange={event => { if (event.target.value) void apply(result, event.target.value); event.target.value = ""; }} className="max-w-full rounded-lg border border-white/15 bg-[#191919] px-2 py-2 text-xs text-white"><option value="">{applyingId === result.id ? "Aplicando…" : "Añadir a una marca…"}</option>{brands.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div>
                    </div>
                </article>;
            })}</div>}
        </div>
    </div>;
}
