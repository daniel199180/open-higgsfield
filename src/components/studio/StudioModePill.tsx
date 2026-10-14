"use client";

import { useState } from "react";
import { Check, ChevronDown, Film, ImageIcon, Layers3, Mic2, VectorSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { PillPopover } from "@/components/command-bar/PillPopover";

export type StudioMode = "image" | "video" | "carousel" | "logo" | "audio";

export function StudioModePill({ mode, onModeChange, disabled = false }: {
    mode: StudioMode;
    onModeChange: (next: StudioMode) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const tCommon = useTranslations("common");
    const options = [
        { id: "image" as const, label: tCommon("image"), icon: ImageIcon },
        { id: "video" as const, label: tCommon("video"), icon: Film },
        { id: "carousel" as const, label: "Carruseles", icon: Layers3 },
        { id: "logo" as const, label: "Logos", icon: VectorSquare },
        { id: "audio" as const, label: "Audio", icon: Mic2 },
    ];
    const active = options.find(option => option.id === mode)!;
    const Icon = active.icon;

    return <PillPopover open={open} onOpenChange={setOpen} width="w-52" trigger={<><Icon className="h-4 w-4" /><span>{active.label}</span><ChevronDown className="h-3.5 w-3.5 text-white/50" /></>}>
        <p className="mb-2 px-1 text-[10px] font-extrabold uppercase tracking-[.08em] text-white/45">Crear</p>
        <div className="space-y-1" role="group" aria-label="Tipo de creación">
            {options.map(({ id, label, icon: OptionIcon }) => <button key={id} type="button" disabled={disabled} aria-pressed={mode === id} onClick={() => { onModeChange(id); setOpen(false); }} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition disabled:opacity-40 ${mode === id ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white/70 hover:bg-white/[.06] hover:text-white"}`}><OptionIcon className="h-4 w-4" /><span className="flex-1">{label}</span>{mode === id && <Check className="h-3.5 w-3.5" />}</button>)}
        </div>
    </PillPopover>;
}
