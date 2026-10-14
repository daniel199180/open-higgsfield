"use client";

import { useCallback, useEffect, useState } from "react";
import { Folder } from "lucide-react";
import type { CompanyFolder } from "@/library/types";

const storageKey = "open-higgsfield:selected-company";

export function useCompanySelection() {
    const [companies, setCompanies] = useState<CompanyFolder[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const refresh = useCallback(async () => {
        try {
            const response = await fetch("/api/companies", { cache: "no-store" });
            if (!response.ok) return;
            const data = await response.json() as { companies?: CompanyFolder[] };
            const available = data.companies ?? [];
            setCompanies(available);
            const remembered = window.localStorage.getItem(storageKey) ?? "";
            setSelectedId(available.some(item => item.id === remembered) ? remembered : "");
        } catch { /* The composer remains usable without a folder. */ }
    }, []);
    useEffect(() => {
        const timer = window.setTimeout(() => { void refresh(); }, 0);
        window.addEventListener("open-higgsfield:companies-updated", refresh);
        return () => { window.clearTimeout(timer); window.removeEventListener("open-higgsfield:companies-updated", refresh); };
    }, [refresh]);
    const select = (id: string) => {
        setSelectedId(id);
        if (id) window.localStorage.setItem(storageKey, id);
        else window.localStorage.removeItem(storageKey);
        window.dispatchEvent(new Event("open-higgsfield:company-selection"));
    };
    return { companies, selectedId, select };
}

export function CompanySelect({ companies, selectedId, onSelect }: { companies: CompanyFolder[]; selectedId: string; onSelect: (id: string) => void }) {
    return <label className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-xs text-white">
        <Folder size={14} className="text-[#ff4d4d]" aria-hidden="true" />
        <span className="sr-only">Carpeta de empresa</span>
        <select aria-label="Carpeta de empresa" value={selectedId} onChange={event => {
            if (event.target.value === "__create") window.dispatchEvent(new Event("open-higgsfield:open-companies"));
            else onSelect(event.target.value);
        }} className="max-w-36 bg-transparent text-xs text-white outline-none">
            <option value="" className="bg-[#191919]">Sin empresa</option>
            {companies.map(company => <option key={company.id} value={company.id} className="bg-[#191919]">{company.name}</option>)}
            <option value="__create" className="bg-[#191919]">+ Crear empresa…</option>
        </select>
    </label>;
}
