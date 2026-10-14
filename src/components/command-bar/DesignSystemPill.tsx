"use client";

import { useState } from "react";
import { Check, Palette } from "lucide-react";
import { PillPopover } from "./PillPopover";
import type { BrandSystem } from "@/social/types";

interface DesignSystemPillProps {
    brands: BrandSystem[];
    selectedId: string;
    loading: boolean;
    onSelect: (id: string) => void;
    emptyLabel?: string;
}

export function DesignSystemPill({ brands, selectedId, loading, onSelect, emptyLabel = "Sistemas de diseño" }: DesignSystemPillProps) {
    const [open, setOpen] = useState(false);
    const selected = brands.find((brand) => brand.id === selectedId);

    return (
        <PillPopover
            open={open}
            onOpenChange={setOpen}
            width="w-72"
            trigger={<><Palette className="h-3 w-3" /><span>{selected?.name ?? emptyLabel}</span></>}
        >
            <p className="mb-2 px-1 text-[10px] font-extrabold uppercase tracking-[.08em] text-white/45">Sistema de diseño</p>
            <div className="max-h-64 space-y-1 overflow-y-auto">
                <button
                    type="button"
                    onClick={() => { onSelect(""); setOpen(false); }}
                    className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs ${!selectedId ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white hover:bg-white/[.06]"}`}
                >
                    <span>Sin sistema de diseño</span>{!selectedId && <Check className="h-3.5 w-3.5" />}
                </button>
                {brands.map((brand) => (
                    <button
                        key={brand.id}
                        type="button"
                        onClick={() => { onSelect(brand.id); setOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs ${brand.id === selectedId ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white hover:bg-white/[.06]"}`}
                    >
                        <span className="h-3 w-3 shrink-0 rounded-full border border-white/20" style={{ background: brand.primaryColor }} />
                        <span className="min-w-0 flex-1 truncate">{brand.name}</span>
                        {brand.id === selectedId && <Check className="h-3.5 w-3.5" />}
                    </button>
                ))}
                {!loading && brands.length === 0 && <p className="px-2.5 py-2 text-xs text-white/50">Todavía no hay marcas guardadas.</p>}
            </div>
            <button
                type="button"
                onClick={() => { setOpen(false); window.dispatchEvent(new Event("open-higgsfield:open-social")); }}
                className="mt-2 w-full rounded-xl border border-white/10 px-2.5 py-2 text-left text-xs font-semibold text-[#ff4d4d] hover:bg-white/[.05]"
            >
                {loading ? "Cargando marcas…" : "Administrar sistemas de diseño"}
            </button>
        </PillPopover>
    );
}
