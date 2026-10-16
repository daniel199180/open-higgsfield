"use client";

import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown } from "lucide-react";
import { FALLBACK_GOOGLE_FONTS, fontFamilyStyle, googleFontCssUrl, validFontFamily } from "@/lib/google-fonts";

async function fetchFonts(url: string): Promise<{ families: string[]; fallback: boolean }> {
    const response = await fetch(url);
    if (!response.ok) throw new Error("No se pudo cargar Google Fonts");
    return response.json();
}

/** Loads only the selected family, never a font file for every search result. */
const previewFonts = new Map<string, { link: HTMLLinkElement; users: number }>();
export function useGoogleFontPreview(family: string) {
    useEffect(() => {
        const href = googleFontCssUrl(family);
        if (!href) return;
        let entry = previewFonts.get(href);
        if (!entry) {
            const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href;
            document.head.appendChild(link);
            entry = { link, users: 0 }; previewFonts.set(href, entry);
        }
        entry.users++;
        return () => { if (--entry.users === 0) { entry.link.remove(); previewFonts.delete(href); } };
    }, [family]);
}

export function GoogleFontPicker({ label, value, onChange }: { label: string; value: string; onChange: (family: string) => void }) {
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const { data, error, isLoading } = useSWR(open ? "/api/fonts" : null, fetchFonts, { revalidateOnFocus: false, revalidateIfStale: false, dedupingInterval: 3600000, shouldRetryOnError: false });
    const families = (data?.families ?? FALLBACK_GOOGLE_FONTS).filter(validFontFamily);
    const matching = families.filter(family => family.toLowerCase().includes(query.trim().toLowerCase()));
    const results = matching.slice(0, 60);
    return <div className="min-w-0">
        <label id={`${id}-label`} className="block text-xs font-medium text-white/65">{label}</label>
        <button ref={trigger} type="button" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={open ? `${id}-options` : undefined} onClick={() => setOpen(current => !current)} className="mt-2 flex w-full items-center justify-between gap-2 rounded-2xl border border-white/10 bg-[#111] px-4 py-3 text-left text-sm text-white hover:border-white/30">
            <span id={`${id}-value`} className="truncate">{value}</span><ChevronDown size={16} />
        </button>
        {open && <div id={`${id}-options`} className="mt-2 rounded-2xl border border-white/15 bg-[#151515] p-3" onKeyDown={event => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } }}>
            <input autoFocus aria-label={`Buscar fuente para ${label.toLowerCase()}`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar en Google Fonts…" className="w-full rounded-lg border border-white/20 bg-black px-3 py-2 text-sm text-white outline-none focus:border-[#ff4d4d]" />
            <p className="my-2 text-[11px] text-white/45">{isLoading ? "Cargando catálogo…" : error || data?.fallback ? "Catálogo básico disponible; no se pudo actualizar Google Fonts." : `${matching.length} familias · busca para filtrar`}</p>
            <div className="max-h-48 overflow-y-auto">{results.map(family => <button type="button" key={family} aria-pressed={family === value} onClick={() => { onChange(family); setOpen(false); setQuery(""); trigger.current?.focus(); }} className={`block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10 ${family === value ? "bg-[#c62828]/20 text-[#ff4d4d]" : "text-white/80"}`}>{family}</button>)}
                {!results.length && <p className="px-3 py-2 text-xs text-white/50">No se encontraron fuentes. Tu selección actual se conserva.</p>}
            </div>
            {matching.length > 60 && <p className="mt-2 text-[11px] text-white/40">Se muestran 60 resultados. Escribe el nombre para encontrar más.</p>}
        </div>}
        <p className="mt-2 truncate text-lg text-white/80" style={{ fontFamily: fontFamilyStyle(value) }}>Aa · Ideas que conectan</p>
    </div>;
}
