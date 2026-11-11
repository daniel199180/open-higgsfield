"use client";
/* eslint-disable @next/next/no-img-element -- authenticated gallery previews use native media elements */

import { useCallback, useEffect, useState } from "react";
import { Check, Images, Loader2, Search } from "lucide-react";

export type GalleryResourceKind = "image" | "video" | "audio";
export interface GalleryResource {
    id: string; kind: GalleryResourceKind; url: string; title: string; createdAt: number;
    source: "generation" | "asset"; taskId?: string;
}
interface GalleryResourcePickerProps {
    kind: GalleryResourceKind;
    onPick: (resource: GalleryResource) => void;
    label?: string;
    compact?: boolean;
}

export function GalleryResourcePicker({ kind, onPick, label = "Galería", compact = false }: GalleryResourcePickerProps) {
    const [open, setOpen] = useState(false);
    const [resources, setResources] = useState<GalleryResource[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const kindName = kind === "image" ? "imagen" : kind === "video" ? "video" : "audio";

    const load = useCallback(async function load() {
        setLoading(true); setError("");
        try {
            const response = await fetch(`/api/gallery/resources?kind=${kind}`, { cache: "no-store" });
            const data = await response.json() as { resources?: GalleryResource[]; error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo cargar la galería.");
            setResources(data.resources ?? []);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar la galería."); }
        finally { setLoading(false); }
    }, [kind]);

    useEffect(() => {
        if (!open) return;
        const refresh = () => void load();
        window.addEventListener("open-higgsfield:gallery-updated", refresh);
        return () => window.removeEventListener("open-higgsfield:gallery-updated", refresh);
    }, [open, load]);

    const filtered = resources.filter(resource => !query.trim() || resource.title.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));
    return <div className="relative">
        <button type="button" onClick={() => { if (!open) void load(); setOpen(!open); }} className={`${compact ? "h-7 px-2 text-[10px]" : "px-3 py-2 text-xs"} inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[.04] font-semibold text-white/75 transition hover:border-[#ff4d4d]/60 hover:text-white`}><Images size={compact ? 12 : 14} /> {label}</button>
        {open && <div className={`${compact ? "mt-2 w-[min(290px,calc(100vw-64px))]" : "absolute left-0 top-11 z-30 w-[min(420px,calc(100vw-32px))]"} rounded-xl border border-white/15 bg-[#151515] p-3 shadow-2xl`}>
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2"><Search size={13} className="text-white/40" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={`Buscar ${kindName}…`} className="w-full bg-transparent py-2 text-xs text-white outline-none placeholder:text-white/35" /><button type="button" onClick={() => void load()} aria-label="Actualizar galería" className="text-[10px] text-white/40 hover:text-white">↻</button></div>
            {loading ? <div className="grid place-items-center py-7 text-white/50"><Loader2 size={18} className="animate-spin" /></div> : error ? <p className="p-3 text-xs text-red-200">{error}</p> : filtered.length === 0 ? <p className="p-3 text-center text-xs text-white/45">No hay {kindName}s generados.</p> : <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto">{filtered.slice(0, 80).map(resource => <button type="button" key={resource.id} title={resource.title} onClick={() => { onPick(resource); setOpen(false); }} className="group relative aspect-square overflow-hidden rounded-md border border-white/10 bg-black hover:border-[#ff4d4d] focus-visible:outline-2 focus-visible:outline-[#ff4d4d]">
                {resource.kind === "image" && <img src={resource.url} alt={resource.title} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />}
                {resource.kind === "video" && <video src={resource.url} muted preload="metadata" className="h-full w-full object-cover" />}
                {resource.kind === "audio" && <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2 text-white/65"><span className="text-2xl">♫</span><span className="w-full truncate text-center text-[9px]">{resource.title}</span></div>}
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/75 px-1 py-1 text-[8px] text-white/80">{resource.title}</span><span className="absolute right-1 top-1 hidden rounded-full bg-[#c62828] p-1 text-white group-hover:block"><Check size={10} /></span>
            </button>)}</div>}
        </div>}
    </div>;
}
