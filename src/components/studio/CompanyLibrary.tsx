"use client";

/* eslint-disable @next/next/no-img-element -- authenticated generated media previews */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, FolderPlus, Search, ArrowLeft, Download, Pencil } from "lucide-react";
import type { ImageTask, VideoTask } from "@/types";
import type { SocialProject, LogoResult } from "@/social/types";
import type { AudioResult } from "@/audio/types";
import type { CompanyFolder, LibraryKind } from "@/library/types";
import type { Asset, RunStatus } from "@/workflows/types";
import { isLayerTask } from "@/lib/image-layer-task";

type RunSummary = { id: string; workflowId: string; companyId?: string; name: string; status: RunStatus; createdAt: number; assetIds: string[] };
type Catalog = { companies: CompanyFolder[]; images: ImageTask[]; videos: VideoTask[]; carousels: SocialProject[]; logos: LogoResult[]; audios: AudioResult[]; runs: RunSummary[]; assets: Asset[] };
type Item = { kind: LibraryKind; id: string; companyId?: string; title: string; detail: string; searchText?: string; date: number; status?: string; preview?: string; href?: string; audio?: string; carouselId?: string; workflowId?: string; runId?: string; videoPreview?: boolean };
const labels: Record<LibraryKind, string> = { image: "Imagen", video: "Video", carousel: "Carrusel", logo: "Logo", audio: "Audio", workflow: "Workflow" };
const empty: Catalog = { companies: [], images: [], videos: [], carousels: [], logos: [], audios: [], runs: [], assets: [] };

export function CompanyLibrary({ onBack }: { onBack: () => void }) {
    const [catalog, setCatalog] = useState<Catalog>(empty);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [folder, setFolder] = useState("all");
    const [kind, setKind] = useState<LibraryKind | "all">("all");
    const [query, setQuery] = useState("");
    const [name, setName] = useState("");
    const [visible, setVisible] = useState(60);
    const refresh = useCallback(async () => {
        try {
            const response = await fetch("/api/library", { cache: "no-store" });
            const data = await response.json() as Catalog & { error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudo cargar la biblioteca.");
            setCatalog(data);
            setError("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar la biblioteca."); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);

    const items = useMemo(() => {
        const all: Item[] = [];
        const carouselTasks = new Set(catalog.carousels.flatMap(project => project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds));
        for (const task of catalog.images) {
            if (isLayerTask(task)) continue;
            if (carouselTasks.has(task.task_id)) continue;
            const count = Math.max(task.result_paths?.length ?? 0, task.result_urls?.length ?? 0);
            for (let index = 0; index < Math.max(1, count); index++) all.push({ kind: "image", id: task.task_id, companyId: task.company_id, title: task.prompt || "Imagen sin descripción", detail: task.model_id, date: Date.parse(task.created_at) || 0, status: task.status, preview: count ? `/api/download/${encodeURIComponent(task.task_id)}?index=${index}` : undefined, href: count ? `/api/download/${encodeURIComponent(task.task_id)}?index=${index}` : undefined });
        }
        for (const task of catalog.videos) all.push({ kind: "video", id: task.task_id, companyId: task.company_id, title: task.prompt || "Video sin descripción", detail: task.model_id, date: Date.parse(task.created_at) || 0, status: task.status, preview: task.video_path ? `/api/download/${encodeURIComponent(task.task_id)}?inline=1` : task.video_urls?.[0], href: task.video_path ? `/api/download/${encodeURIComponent(task.task_id)}` : task.video_urls?.[0] });
        for (const project of catalog.carousels) if (project.format === "carousel") {
            const taskId = (project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds).find(id => catalog.images.some(task => task.task_id === id && task.status === "COMPLETED" && (task.result_paths?.length || task.result_urls?.length)));
            all.push({ kind: "carousel", id: project.id, companyId: project.companyId, title: project.name, detail: project.brief, searchText: project.slides?.map(slide => `${slide.title} ${slide.body} ${slide.visualPrompt}`).join(" "), date: project.createdAt, status: project.status, preview: taskId ? `/api/download/${encodeURIComponent(taskId)}?index=0` : undefined, carouselId: project.id });
        }
        for (const logo of catalog.logos) all.push({ kind: "logo", id: logo.id, companyId: logo.companyId, title: logo.prompt, detail: logo.mode === "trace" ? "Vectorización" : logo.modelId || "Logo vectorial", date: logo.createdAt, preview: `/api/workflows/assets/${logo.previewAssetId}`, href: `/api/workflows/assets/${logo.vectorAssetId}?download=1` });
        for (const audio of catalog.audios) all.push({ kind: "audio", id: audio.id, companyId: audio.companyId, title: audio.voiceName, detail: audio.text, date: Date.parse(audio.createdAt) || 0, audio: `/api/workflows/assets/${audio.assetId}`, href: `/api/workflows/assets/${audio.assetId}?download=1` });
        const assetById = new Map(catalog.assets.map(asset => [asset.id, asset]));
        for (const run of catalog.runs) {
            const assetId = run.assetIds.find(id => ["image", "video"].includes(assetById.get(id)?.kind ?? ""));
            const asset = assetId ? assetById.get(assetId) : undefined;
            all.push({ kind: "workflow", id: run.id, companyId: run.companyId, title: run.name, detail: "Ejecución de workflow", date: run.createdAt, status: run.status, preview: assetId ? `/api/workflows/assets/${assetId}` : undefined, videoPreview: asset?.kind === "video", workflowId: run.workflowId, runId: run.id });
        }
        return all.sort((a, b) => b.date - a.date);
    }, [catalog]);
    const filtered = useMemo(() => items.filter(item => (folder === "all" || (folder === "unassigned" ? !item.companyId : item.companyId === folder)) && (kind === "all" || item.kind === kind) && (!query.trim() || `${item.title} ${item.detail} ${item.searchText ?? ""} ${item.id}`.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")))), [items, folder, kind, query]);
    const counts = useMemo(() => {
        const result: Record<string, number> = { all: items.length, unassigned: 0 };
        for (const item of items) result[item.companyId || "unassigned"] = (result[item.companyId || "unassigned"] ?? 0) + 1;
        return result;
    }, [items]);

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
    async function move(item: Item, nextId: string) {
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
            <nav aria-label="Carpetas de empresas" className="mb-7 flex gap-2 overflow-x-auto pb-2">{[{ id: "all", name: "Todas" }, ...catalog.companies.map(item => ({ id: item.id, name: item.name })), { id: "unassigned", name: "Sin empresa" }].map(entry => <div key={entry.id} className={`flex shrink-0 items-center rounded-xl border ${folder === entry.id ? "border-[#ff4d4d]/65 bg-[#ff4d4d]/15" : "border-white/10 bg-[#111]"}`}><button type="button" onClick={() => { setFolder(entry.id); setVisible(60); }} className="inline-flex items-center gap-2 px-3 py-2 text-sm"><Folder size={15} className="text-[#ff4d4d]" />{entry.name}<span className="text-xs text-white/45">{counts[entry.id] ?? 0}</span></button>{catalog.companies.some(item => item.id === entry.id) && <button type="button" aria-label={`Renombrar ${entry.name}`} title="Renombrar" onClick={() => void renameCompany(catalog.companies.find(item => item.id === entry.id)!)} className="pr-3 text-white/45 hover:text-white"><Pencil size={13} /></button>}</div>)}</nav>
            <div className="mb-5 flex flex-wrap gap-3"><label className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-white/15 bg-[#111] px-3"><Search size={16} className="text-white/45" /><input aria-label="Buscar generaciones" value={query} onChange={event => { setQuery(event.target.value); setVisible(60); }} placeholder="Buscar por descripción, modelo o ID…" className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-white/35" /></label><select aria-label="Filtrar por tipo" value={kind} onChange={event => { setKind(event.target.value as LibraryKind | "all"); setVisible(60); }} className="rounded-xl border border-white/15 bg-[#111] px-3 py-2 text-sm"><option value="all">Todos los tipos</option>{(Object.keys(labels) as LibraryKind[]).map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></div>
            <p className="mb-4 text-xs text-white/45">{filtered.length} resultado{filtered.length === 1 ? "" : "s"}{busy ? " · Guardando…" : ""}</p>
            {loading ? <p className="py-20 text-center text-sm text-white/50">Cargando generaciones…</p> : filtered.length === 0 ? <p className="rounded-2xl border border-dashed border-white/15 p-12 text-center text-sm text-white/50">No hay generaciones con estos filtros.</p> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{filtered.slice(0, visible).map((item, index) => <article key={`${item.kind}:${item.id}:${index}`} className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]"><div className="grid aspect-[4/3] place-items-center overflow-hidden bg-[#080808]">{(item.kind === "video" || item.videoPreview) && item.preview ? <video src={item.preview} controls preload="metadata" className="h-full w-full object-contain" /> : item.preview ? <a href={item.href || item.preview} target="_blank" rel="noreferrer" className="h-full w-full"><img src={item.preview} alt={item.title} className="h-full w-full object-contain" /></a> : <Folder size={34} className="text-white/20" />}</div><div className="space-y-2 p-4"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold text-[#ff4d4d]">{labels[item.kind]}</span><time className="text-white/40">{item.date ? new Date(item.date).toLocaleDateString("es") : ""}</time></div><h2 className="line-clamp-2 min-h-10 text-sm font-medium">{item.title}</h2><p className="line-clamp-1 text-xs text-white/45">{item.status && item.status !== "COMPLETED" ? `${item.status} · ` : ""}{item.detail}</p>{item.audio && <audio controls preload="none" src={item.audio} className="w-full" />}<div className="flex items-center justify-between gap-2 pt-1">{item.carouselId ? <a href={`?mode=carousel&carousel=${encodeURIComponent(item.carouselId)}`} className="text-xs text-white/70 hover:text-white">Abrir carrusel</a> : item.runId && item.workflowId ? <a href={`?workspace=workflows&workflow=${encodeURIComponent(item.workflowId)}&run=${encodeURIComponent(item.runId)}`} className="text-xs text-white/70 hover:text-white">Abrir ejecución</a> : item.href ? <a href={item.href} target="_blank" rel="noreferrer" aria-label={`Abrir ${labels[item.kind].toLowerCase()}`} className="text-white/65 hover:text-white"><Download size={16} /></a> : <span /> }<select aria-label={`Empresa para ${labels[item.kind].toLowerCase()} ${item.title.slice(0, 40)}`} disabled={busy} value={item.companyId ?? ""} onChange={event => void move(item, event.target.value)} className="max-w-40 rounded-lg border border-white/15 bg-[#191919] px-2 py-1.5 text-xs text-white disabled:opacity-50"><option value="">Sin empresa</option>{catalog.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></div></div></article>)}</div>}
            {filtered.length > visible && <button type="button" onClick={() => setVisible(current => current + 60)} className="mx-auto mt-8 block rounded-xl border border-white/20 px-5 py-2 text-sm text-white hover:border-[#ff4d4d]/60">Mostrar más</button>}
        </div>
    </main>;
}
