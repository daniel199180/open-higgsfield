"use client";
/* eslint-disable @next/next/no-img-element -- authenticated gallery previews bypass the shared image optimizer */

import { useEffect, useState } from "react";
import { Check, Images, Loader2, Search } from "lucide-react";

export interface GalleryImage {
    id: string;
    url: string;
    title: string;
    createdAt: number;
    source: "generation" | "upload" | "asset";
    taskId?: string;
}

interface GalleryImagePickerProps {
    onPick: (image: GalleryImage) => void;
    label?: string;
    compact?: boolean;
    contained?: boolean;
}

export function GalleryImagePicker({ onPick, label = "Elegir de galería", compact = false, contained = false }: GalleryImagePickerProps) {
    const [open, setOpen] = useState(false);
    const [images, setImages] = useState<GalleryImage[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function load() {
        setLoading(true); setError("");
        try {
            const response = await fetch("/api/gallery/images", { cache: "no-store" });
            const data = await response.json() as { images?: GalleryImage[]; error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo cargar la galería.");
            setImages(data.images ?? []);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar la galería."); }
        finally { setLoading(false); }
    }

    useEffect(() => {
        if (!open) return;
        const refresh = () => void load();
        window.addEventListener("open-higgsfield:gallery-updated", refresh);
        return () => window.removeEventListener("open-higgsfield:gallery-updated", refresh);
    }, [open]);

    const filtered = images.filter(image => !query.trim() || image.title.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));

    return <div className="relative">
        <button type="button" onClick={() => { if (!open) void load(); setOpen(!open); }} className={`${compact ? "h-7 px-2 text-[10px]" : "px-3 py-2 text-xs"} ${contained ? "w-full justify-center" : ""} inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[.04] font-semibold text-white/75 transition hover:border-[#ff4d4d]/60 hover:text-white`}>
            <Images size={compact ? 12 : 14} /> {label}
        </button>
        {open && <div className={`${contained ? "mt-2 w-full" : compact ? "mt-2 w-[min(290px,calc(100vw-64px))]" : "absolute left-0 top-11 z-30 w-[min(420px,calc(100vw-32px))]"} rounded-xl border border-white/15 bg-[#151515] p-3 shadow-2xl`}>
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2">
                <Search size={13} className="text-white/40" />
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar imagen…" className="w-full bg-transparent py-2 text-xs text-white outline-none placeholder:text-white/35" />
                <button type="button" onClick={() => void load()} aria-label="Actualizar galería" className="text-[10px] text-white/40 hover:text-white">↻</button>
            </div>
            {loading ? <div className="grid place-items-center py-7 text-white/50"><Loader2 size={18} className="animate-spin" /></div> : error ? <p className="p-3 text-xs text-red-200">{error}</p> : filtered.length === 0 ? <p className="p-3 text-center text-xs text-white/45">No hay imágenes guardadas.</p> : <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto">{filtered.slice(0, 80).map(image => <button type="button" key={image.id} title={image.title} onClick={() => { onPick(image); setOpen(false); }} className="group relative aspect-square overflow-hidden rounded-md border border-white/10 bg-black hover:border-[#ff4d4d] focus-visible:outline-2 focus-visible:outline-[#ff4d4d]"><img src={image.url} alt={image.title} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" /><span className="absolute inset-x-0 bottom-0 truncate bg-black/75 px-1 py-1 text-[8px] text-white/80">{image.title}</span><span className="absolute right-1 top-1 hidden rounded-full bg-[#c62828] p-1 text-white group-hover:block"><Check size={10} /></span></button>)}</div>}
        </div>}
    </div>;
}
