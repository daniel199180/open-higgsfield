"use client";

import { useRef, useState } from "react";
import { AtSign, Image as ImageIcon, Palette, Type, VectorSquare } from "lucide-react";
import type { BrandMentionKind, BrandMentionOption } from "@/social/brand";

const kindLabels: Record<BrandMentionKind, string> = {
    texto: "Texto",
    color: "Color",
    imagen: "Imagen",
    logo: "Logo",
};

function kindIcon(kind: BrandMentionKind) {
    if (kind === "color") return <Palette size={14} />;
    if (kind === "imagen") return <ImageIcon size={14} />;
    if (kind === "logo") return <VectorSquare size={14} />;
    return <Type size={14} />;
}

function mentionAt(value: string, cursor: number) {
    const before = value.slice(0, cursor);
    const match = /(?:^|[\s([{"'])@([a-z0-9_-]*)$/i.exec(before);
    if (!match) return null;
    return { start: match.index + match[0].lastIndexOf("@"), query: match[1] };
}

export function BrandMentionTextarea({ id, value, onChange, options, disabled, maxLength, className }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    options: BrandMentionOption[];
    disabled?: boolean;
    maxLength?: number;
    className: string;
}) {
    const textarea = useRef<HTMLTextAreaElement>(null);
    const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
    const [selected, setSelected] = useState(0);
    const query = mention?.query.toLowerCase() ?? "";
    const filtered = mention ? options.filter(option => option.token.includes(query) || option.label.toLowerCase().includes(query) || option.detail.toLowerCase().includes(query)).slice(0, 12) : [];

    function refreshMention(nextValue: string, cursor: number) {
        const nextMention = mentionAt(nextValue, cursor);
        setMention(nextMention);
        setSelected(0);
    }

    function insert(option: BrandMentionOption) {
        const input = textarea.current;
        if (!input || !mention) return;
        const cursor = input.selectionStart;
        const nextValue = `${value.slice(0, mention.start)}@${option.token} ${value.slice(cursor)}`;
        const nextCursor = mention.start + option.token.length + 2;
        onChange(nextValue);
        setMention(null);
        requestAnimationFrame(() => { input.focus(); input.setSelectionRange(nextCursor, nextCursor); });
    }

    return <div className="relative">
        <textarea ref={textarea} id={id} disabled={disabled} maxLength={maxLength} value={value} className={className} onChange={event => { onChange(event.target.value); refreshMention(event.target.value, event.target.selectionStart); }} onFocus={event => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)} onClick={event => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={event => {
            if (!mention || !filtered.length) {
                if (event.key === "Escape") setMention(null);
                return;
            }
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected(current => (current + 1) % filtered.length); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setSelected(current => (current - 1 + filtered.length) % filtered.length); }
            else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insert(filtered[selected]); }
            else if (event.key === "Escape") { event.preventDefault(); setMention(null); }
        }} onBlur={() => window.setTimeout(() => setMention(null), 120)} aria-autocomplete="list" aria-controls={mention && filtered.length ? `${id}-mentions` : undefined} />
        {mention && filtered.length > 0 && <div id={`${id}-mentions`} role="listbox" aria-label="Menciones disponibles" className="absolute inset-x-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-white/15 bg-[#181818] p-2 shadow-2xl shadow-black/50">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[.14em] text-white/35">Insertar mención</p>
            {filtered.map((option, index) => <button key={`${option.kind}-${option.token}`} type="button" role="option" aria-selected={selected === index} onMouseDown={event => event.preventDefault()} onClick={() => insert(option)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition ${selected === index ? "bg-[#c62828]/20 text-white" : "text-white/70 hover:bg-white/[.06]"}`}>
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[.07] text-[#ff6b6b]">{kindIcon(option.kind)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">@{option.token}</span><span className="block truncate text-[10px] text-white/40">{kindLabels[option.kind]} · {option.label} · {option.detail}</span></span>
                <AtSign size={13} className="shrink-0 text-white/25" />
            </button>)}
        </div>}
    </div>;
}
