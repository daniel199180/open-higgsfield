"use client";

import { useState } from "react";
import { Wand2, Check, Search } from "lucide-react";
import { PillPopover } from "./PillPopover";
import { VIDEO_CAPABILITIES } from "@/models/capabilities/video";
import type { AttachmentItem } from "@/components/studio/AttachmentZone";
import { hasActiveModelApi, modelProviderName } from "@/lib/model-availability";

interface VideoModelPillProps {
    modelId: string;
    variantId: string;
    onModelChange: (modelId: string, variantId: string) => void;
    attachments: AttachmentItem[];
}

export function VideoModelPill({ modelId, variantId: _variantId, onModelChange }: VideoModelPillProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const model = VIDEO_CAPABILITIES[modelId];
    const label = hasActiveModelApi(model) ? model?.label ?? modelId : "Elige modelo";
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleModels = Object.values(VIDEO_CAPABILITIES)
        .filter(hasActiveModelApi)
        .filter((candidate) => !normalizedQuery || `${candidate.label} ${candidate.provider_model_id ?? ""} ${modelProviderName(candidate)}`.toLocaleLowerCase().includes(normalizedQuery))
        .sort((left, right) => (right.sort_key ?? 0) - (left.sort_key ?? 0) || left.label.localeCompare(right.label));

    return (
        <PillPopover
            open={open}
            onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}
            width="w-80"
            contentClassName="flex max-h-[70dvh] min-h-0 flex-col overflow-hidden"
            trigger={
                <>
                    <Wand2 className="h-3 w-3" />
                    <span>{label}</span>
                </>
            }
        >
            <p className="mb-2 shrink-0 px-1 text-[10px] font-extrabold uppercase tracking-[.08em]" style={{ color: "rgba(244,247,251,.44)" }}>Modelos con API activa</p>
            <label className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 text-white/60"><Search className="h-3.5 w-3.5" /><input aria-label="Buscar modelos de vídeo" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar modelo o proveedor…" className="w-full bg-transparent py-2 text-xs text-white outline-none placeholder:text-white/35" /></label>
            <div className="model-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
                <div className="space-y-0.5 pr-1">{visibleModels.map((candidate) => {
                    const isSelected = candidate.id === modelId;
                    return <button key={candidate.id} type="button" onClick={() => { onModelChange(candidate.id, candidate.id === modelId ? _variantId : ""); setOpen(false); }} className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/[.06]" style={{ background: isSelected ? "rgba(255,77,77,.1)" : "transparent", color: isSelected ? "#ff4d4d" : "#f4f7fb", fontWeight: isSelected ? 700 : 500 }}><span className="min-w-0 flex-1 truncate">{candidate.label}</span><span className="shrink-0 rounded-md border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10px] font-medium text-white/55">{modelProviderName(candidate)}</span>{isSelected && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "#ff4d4d" }} />}</button>;
                })}{visibleModels.length === 0 && <p className="px-2 py-5 text-center text-xs leading-relaxed text-white/45">{normalizedQuery ? "No hay modelos activos que coincidan." : "No hay modelos de vídeo con una API activa."}</p>}</div>
            </div>
        </PillPopover>
    );
}
