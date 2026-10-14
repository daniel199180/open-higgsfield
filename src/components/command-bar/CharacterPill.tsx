"use client";

import { useState } from "react";
import { Check, UserRound } from "lucide-react";
import type { Character } from "@/social/types";
import { PillPopover } from "./PillPopover";

export function CharacterPill({ characters, selectedId, onSelect }: { characters: Character[]; selectedId: string; onSelect: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    const selected = characters.find(item => item.id === selectedId);
    return <PillPopover open={open} onOpenChange={setOpen} width="w-72" trigger={<><UserRound className="h-3 w-3" /><span>{selected?.name ?? "Personaje"}</span></>}>
        <p className="mb-2 px-1 text-[10px] font-extrabold uppercase tracking-[.08em] text-white/45">Personaje recurrente</p>
        <div className="max-h-64 space-y-1 overflow-y-auto">
            <button type="button" className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs text-white hover:bg-white/[.06]" onClick={() => { onSelect(""); setOpen(false); }}>Sin personaje {!selectedId && <Check size={14} />}</button>
            {characters.map(character => <button type="button" key={character.id} onClick={() => { onSelect(character.id); setOpen(false); }} className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs ${character.id === selectedId ? "bg-[#ff4d4d]/10 text-[#ff4d4d]" : "text-white hover:bg-white/[.06]"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- private authenticated thumbnail */}
                <img src={`/api/workflows/assets/${character.coverAssetId}`} alt="" className="h-8 w-8 rounded-lg object-cover" /><span className="min-w-0 flex-1 truncate">{character.name}</span>{character.id === selectedId && <Check size={14} />}
            </button>)}
            {!characters.length && <p className="px-2.5 py-2 text-xs text-white/50">Todavía no hay personajes.</p>}
        </div>
        <button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new Event("open-higgsfield:open-characters")); }} className="mt-2 w-full rounded-xl bg-[#d92f38] px-2.5 py-2 text-left text-xs font-semibold text-white hover:bg-[#ed3c46]">Crear o administrar personajes</button>
    </PillPopover>;
}
