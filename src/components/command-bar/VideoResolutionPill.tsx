"use client";

import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { PillPopover } from "./PillPopover";

interface VideoResolutionPillProps {
    options: string[];
    value: string;
    onChange: (value: string) => void;
}

export function VideoResolutionPill({ options, value, onChange }: VideoResolutionPillProps) {
    const [open, setOpen] = useState(false);
    if (options.length === 0) return null;
    const selected = value || options[0];
    return <PillPopover open={open} onOpenChange={setOpen} width="w-52" trigger={<><Maximize2 className="h-3 w-3" /><span>{selected}</span></>}>
        <p className="mb-2 px-1 text-[10px] font-extrabold uppercase tracking-[.08em] text-white/45">Tamaño del video</p>
        <div className="grid grid-cols-2 gap-1.5">
            {options.map(option => <button key={option} type="button" onClick={() => { onChange(option); setOpen(false); }} className="rounded-[10px] border px-3 py-2 text-left text-xs font-bold transition-colors" style={{ background: selected === option ? "#c62828" : "rgba(255,255,255,.04)", color: selected === option ? "#ffffff" : "#f4f7fb", borderColor: selected === option ? "transparent" : "rgba(255,255,255,.08)" }}>{option}</button>)}
        </div>
    </PillPopover>;
}
