"use client";

import { ImagePlus, AtSign, Trash2 } from "lucide-react";
import { MAX_BRAND_REFERENCES } from "@/social/brand";
import type { BrandSystem } from "@/social/types";

type References = NonNullable<BrandSystem["references"]>;

export function BrandReferencesEditor({ references, disabled, onChange, onUpload, onMention }: {
    references: References; disabled: boolean; onChange: (value: References) => void;
    onUpload: (files: File[]) => void; onMention: (name: string) => void;
}) {
    return <section className="space-y-3" aria-label="Referencias visuales">
        <h4 className="text-sm font-semibold">Referencias visuales <span className="text-white/40">{references.length}/{MAX_BRAND_REFERENCES}</span></h4>
        <p className="text-xs leading-5 text-white/50">Añade ejemplos de composición, fotografía o estilo. Usa su @nombre en las reglas visuales para explicar qué tomar de cada imagen. No se usarán como logos.</p>
        <div className="grid gap-3 sm:grid-cols-2">{references.map((item, index) => <div key={item.assetId} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[.03]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/workflows/assets/${item.assetId}`} alt={`Referencia ${item.name}`} className="h-36 w-full bg-neutral-600 object-contain" />
            <div className="space-y-2 p-3"><label className="block text-xs text-white/60">Nombre para mencionar<input aria-label={`Nombre de referencia ${index + 1}`} disabled={disabled} pattern="[a-z][a-z0-9_-]{0,39}" required maxLength={40} value={item.name} onChange={event => onChange(references.map((reference, i) => i === index ? { ...reference, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") } : reference))} className="mt-2 w-full rounded-lg border border-white/15 bg-[#111] p-2 text-white" /></label>
                <div className="flex items-center justify-between"><button type="button" disabled={disabled || !/^[a-z][a-z0-9_-]{0,39}$/.test(item.name)} onClick={() => onMention(item.name)} className="flex items-center gap-1 text-xs text-[#ff4d4d]"><AtSign size={14} />Mencionar en reglas</button><button type="button" disabled={disabled} aria-label={`Quitar referencia ${item.name}`} onClick={() => onChange(references.filter((_, i) => i !== index))} className="p-2 text-white/50 hover:text-red-300"><Trash2 size={14} /></button></div>
            </div>
        </div>)}</div>
        <label className="block rounded-2xl border border-dashed border-white/20 p-4 text-xs text-white/60"><span className="flex items-center gap-2"><ImagePlus size={16} />Añadir imágenes de referencia</span><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/avif" disabled={disabled || references.length >= MAX_BRAND_REFERENCES} className="mt-3 w-full" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) onUpload(files); }} /></label>
    </section>;
}
