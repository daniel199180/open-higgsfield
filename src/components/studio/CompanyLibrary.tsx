"use client";

/* eslint-disable @next/next/no-img-element -- authenticated generated media previews */
import { useCallback, useEffect, useState } from "react";
import { Folder, FolderPlus, Search, ArrowLeft, Download, Pencil } from "lucide-react";
import type { CompanyFolder, CompanyLibraryItem, CompanyLibraryPage, LibraryKind } from "@/library/types";

type Catalog = { companies: CompanyFolder[]; items: CompanyLibraryItem[]; page: CompanyLibraryPage; counts: Record<string, number> };
const labels: Record<LibraryKind, string> = { image: "Imagen", video: "Video", carousel: "Carrusel", logo: "Logo", audio: "Audio", workflow: "Workflow" };
const empty: Catalog = { companies: [], items: [], page: { page: 1, pageSize: 15, total: 0, totalPages: 1 }, counts: { all: 0, unassigned: 0 } };

export function CompanyLibrary({ onBack }: { onBack: () => void }) {
    const [catalog, setCatalog] = useState<Catalog>(empty);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [folder, setFolder] = useState("all");
    const [kind, setKind] = useState<LibraryKind | "all">("all");
    const [query, setQuery] = useState("");
    const [name, setName] = useState("");
    const [page, setPage] = useState(1);
    const refresh = useCallback(async () => {
        try {
            const params = new URLSearchParams({ page: String(page), folder, kind, query });
            const response = await fetch(`/api/library?${params.toString()}`, { cache: "no-store" });
            const data = await response.json() as Catalog & { error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo cargar la biblioteca.");
            setCatalog(data);
            setError("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar la biblioteca."); }
        finally { setLoading(false); }
    }, [folder, kind, page, query]);
    // Fetching the selected server-side page is the external synchronization this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void refresh(); }, [refresh]);

    async function createCompany(event: React.FormEvent) {
        event.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name: name.trim() }) });
            const data = await response.json() as { company?: CompanyFolder; error?: string };
            if (!response.ok || !data.company) throw new Error(data.error || "No se pudo crear la empresa.");
            setName(""); setFolder(data.company.id); window.localStorage.setItem("open-higgsfield:selected-company", data.company.id); await refresh();
            window.dispatchEvent(new Event("open-higgsfield:companies-updated"));
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo crear la empresa."); }
        finally { setBusy(false); }
    }
    async function renameCompany(company: CompanyFolder) {
        const nextName = window.prompt("Nuevo nombre de la empresa", company.name)?.trim();
        if (!nextName || nextName === company.name || busy) return;
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename", id: company.id, name: nextName }) });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo renombrar la empresa.");
            await refresh(); window.dispatchEvent(new Event("open-higgsfield:companies-updated"));
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo renombrar la empresa."); }
        finally { setBusy(false); }
    }
    async function move(item: CompanyLibraryItem, nextId: string) {
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: item.kind, id: item.id, companyId: nextId || null }) });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo mover la generación.");
            await refresh();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo mover la generación."); }
        finally { setBusy(false); }
    }

    return <main className="min-h-screen bg-black px-4 pb-20 pt-20 text-white sm:px-8">
        <div className="mx-auto max-w-7xl">
            <button type="button" onClick={onBack} className="mb-6 inline-flex items-center gap-2 text-sm text-white/65 hover:text-white"><ArrowLeft size={16} /> Volver al estudio</button>
            <header className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><div className="mb-2 flex items-center gap-3 text-[#ff4d4d]"><Folder size={25} /><span className="text-xs font-bold uppercase tracking-[.18em]">Biblioteca</span></div><h1 className="text-3xl font-semibold">Carpetas por empresa</h1><p className="mt-2 text-sm text-white/50">Busca y organiza imágenes, videos, carruseles, logos, audios y workflows anteriores.</p></div><form onSubmit={createCompany} className="flex w-full gap-2 sm:w-auto"><input aria-label="Nombre de la nueva empresa" value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Nombre de la empresa" className="min-w-0 flex-1 rounded-xl border border-white/15 bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#ff4d4d]" /><button type="submit" disabled={!name.trim() || busy} className="inline-flex items-center gap-2 rounded-xl bg-[#c62828] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"><FolderPlus size={16} /> Crear carpeta</button></form></header>
            {error && <p role="alert" className="mb-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
            <nav aria-label="Carpetas de empresas" className="mb-7 flex gap-2 overflow-x-auto pb-2">{[{ id: "all", name: "Todas" }, ...catalog.companies.map(item => ({ id: item.id, name: item.name })), { id: "unassigned", name: "Sin empresa" }].map(entry => <div key={entry.id} className={`flex shrink-0 items-center rounded-xl border ${folder === entry.id ? "border-[#ff4d4d]/65 bg-[#ff4d4d]/15" : "border-white/10 bg-[#111]"}`}><button type="button" onClick={() => { setFolder(entry.id); setPage(1); }} className="inline-flex items-center gap-2 px-3 py-2 text-sm"><Folder size={15} className="text-[#ff4d4d]" />{entry.name}<span className="text-xs text-white/45">{catalog.counts[entry.id] ?? 0}</span></button>{catalog.companies.some(item => item.id === entry.id) && <button type="button" aria-label={`Renombrar ${entry.name}`} title="Renombrar" onClick={() => void renameCompany(catalog.companies.find(item => item.id === entry.id)!)} className="pr-3 text-white/45 hover:text-white"><Pencil size={13} /></button>}</div>)}</nav>
            <div className="mb-5 flex flex-wrap gap-3"><label className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-white/15 bg-[#111] px-3"><Search size={16} className="text-white/45" /><input aria-label="Buscar generaciones" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="Buscar por descripción, modelo o ID…" className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-white/35" /></label><select aria-label="Filtrar por tipo" value={kind} onChange={event => { setKind(event.target.value as LibraryKind | "all"); setPage(1); }} className="rounded-xl border border-white/15 bg-[#111] px-3 py-2 text-sm"><option value="all">Todos los tipos</option>{(Object.keys(labels) as LibraryKind[]).map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></div>
            <p className="mb-4 text-xs text-white/45">{catalog.page.total} resultado{catalog.page.total === 1 ? "" : "s"}{busy ? " · Guardando…" : ""}</p>
            {loading ? <p className="py-20 text-center text-sm text-white/50">Cargando generaciones…</p> : catalog.items.length === 0 ? <p className="rounded-2xl border border-dashed border-white/15 p-12 text-center text-sm text-white/50">No hay generaciones con estos filtros.</p> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{catalog.items.map((item, index) => <article key={`${item.kind}:${item.id}:${index}`} className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]"><div className="grid aspect-[4/3] place-items-center overflow-hidden bg-[#080808]">{(item.kind === "video" || item.videoPreview) && item.preview ? <video src={item.preview} controls preload="metadata" className="h-full w-full object-contain" /> : item.preview ? <a href={item.href || item.preview} target="_blank" rel="noreferrer" className="h-full w-full"><img src={item.preview} alt={item.title} className="h-full w-full object-contain" /></a> : <Folder size={34} className="text-white/20" />}</div><div className="space-y-2 p-4"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold text-[#ff4d4d]">{labels[item.kind]}</span><time className="text-white/40">{item.date ? new Date(item.date).toLocaleDateString("es") : ""}</time></div><h2 className="line-clamp-2 min-h-10 text-sm font-medium">{item.title}</h2><p className="line-clamp-1 text-xs text-white/45">{item.status && item.status !== "COMPLETED" ? `${item.status} · ` : ""}{item.detail}</p>{item.audio && <audio controls preload="none" src={item.audio} className="w-full" />}<div className="flex items-center justify-between gap-2 pt-1">{item.carouselId ? <a href={`?mode=carousel&carousel=${encodeURIComponent(item.carouselId)}`} className="text-xs text-white/70 hover:text-white">Abrir carrusel</a> : item.runId && item.workflowId ? <a href={`?workspace=workflows&workflow=${encodeURIComponent(item.workflowId)}&run=${encodeURIComponent(item.runId)}`} className="text-xs text-white/70 hover:text-white">Abrir ejecución</a> : item.href ? <a href={item.href} target="_blank" rel="noreferrer" aria-label={`Abrir ${labels[item.kind].toLowerCase()}`} className="text-white/65 hover:text-white"><Download size={16} /></a> : <span /> }<select aria-label={`Empresa para ${labels[item.kind].toLowerCase()} ${item.title.slice(0, 40)}`} disabled={busy} value={item.companyId ?? ""} onChange={event => void move(item, event.target.value)} className="max-w-40 rounded-lg border border-white/15 bg-[#191919] px-2 py-1.5 text-xs text-white disabled:opacity-50"><option value="">Sin empresa</option>{catalog.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></div></div></article>)}</div>}
            {catalog.page.totalPages > 1 && <nav aria-label="Paginación de archivos" className="mt-8 flex items-center justify-center gap-3"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(current => current - 1)} className="rounded-xl border border-white/20 px-4 py-2 text-sm text-white disabled:opacity-40">Anterior</button><span className="text-xs text-white/55">Página {catalog.page.page} de {catalog.page.totalPages} · 15 por página</span><button type="button" disabled={page >= catalog.page.totalPages || loading} onClick={() => setPage(current => current + 1)} className="rounded-xl border border-white/20 px-4 py-2 text-sm text-white disabled:opacity-40">Siguiente</button></nav>}
        </div>
    </main>;
}
