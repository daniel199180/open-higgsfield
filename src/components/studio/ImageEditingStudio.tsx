"use client";

/* eslint-disable @next/next/no-img-element -- authenticated gallery previews */

import { useEffect, useRef, useState } from "react";
import { Images, Loader2, Upload, X } from "lucide-react";
import { useImageTasks, revalidateImageTasks } from "@/hooks/useImageTasks";
import { ImageEditor } from "@/components/tasks/ImageEditor";
import { useCompanySelection } from "@/components/command-bar/CompanySelect";
import { isLayerTask } from "@/lib/image-layer-task";
import type { EditorDocument } from "@/lib/editor-document";

type Selection = { taskId: string; index: number; imageUrl: string; prompt?: string; documentId?: string };
type SavedDocument = Omit<EditorDocument, "history"> & { versions: number; previewTaskId: string; previewIndex: number };

export function ImageEditingStudio({ onBack, registerBeforeLeave }: { onBack: () => void; registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void }) {
    const { tasks, isLoading } = useImageTasks();
    const { companies } = useCompanySelection();
    const [folderFilter, setFolderFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<Selection | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const [savedDocuments, setSavedDocuments] = useState<SavedDocument[]>([]);
    const [documentsError, setDocumentsError] = useState("");
    const inFlight = useRef(false);
    const handledQuerySelection = useRef(false);
    useEffect(() => {
        if (!pickerOpen) return;
        let active = true;
        fetch("/api/images/documents", { cache: "no-store" }).then(async response => {
            const result = await response.json(); if (!response.ok) throw new Error(result.error || "No se pudieron cargar las ediciones guardadas.");
            if (active) { setSavedDocuments(result.documents ?? []); setDocumentsError(""); }
        }).catch(cause => { if (active) setDocumentsError(cause.message); });
        return () => { active = false; };
    }, [pickerOpen]);
    useEffect(() => {
        if (!pickerOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !inFlight.current) setPickerOpen(false); };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [pickerOpen]);
    const images = tasks.filter((task) => !isLayerTask(task) && !task.reuse_state?.editor_internal && task.status === "COMPLETED" && (task.result_paths?.length || task.result_urls?.length)
        && (folderFilter === "all" || (folderFilter === "unassigned" ? !task.company_id : task.company_id === folderFilter))
        && (!search.trim() || `${task.prompt ?? ""} ${task.model_id}`.toLocaleLowerCase("es").includes(search.trim().toLocaleLowerCase("es"))))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .flatMap((task) => Array.from({ length: Math.min(10, Math.max(task.result_paths?.length ?? 0, task.result_urls?.length ?? 0)) }, (_, index) => ({
            taskId: task.task_id, index, imageUrl: `/api/download/${encodeURIComponent(task.task_id)}?index=${index}`, prompt: task.prompt,
        })).filter(({ index }) => !!task.result_paths?.[index] || /^data:image\/(?:png|jpeg|webp);base64,/.test(task.result_urls?.[index] ?? "")));

    useEffect(() => {
        if (handledQuerySelection.current || selected) return;
        const query = new URLSearchParams(window.location.search);
        const taskId = query.get("task");
        const index = Number(query.get("index") ?? "0");
        if (!taskId || !Number.isInteger(index) || index < 0) return;
        const task = tasks.find(item => item.task_id === taskId);
        if (!task || task.status !== "COMPLETED") return;
        const available = Boolean(task.result_paths?.[index]) || /^data:image\/(?:png|jpeg|webp);base64,/.test(task.result_urls?.[index] ?? "");
        if (!available) return;
        handledQuerySelection.current = true;
        setSelected({ taskId, index, imageUrl: `/api/download/${encodeURIComponent(taskId)}?index=${index}`, prompt: task.prompt, documentId: crypto.randomUUID() });
        query.delete("task");
        query.delete("index");
        const url = new URL(window.location.href);
        url.search = query.toString();
        window.history.replaceState(null, "", url);
    }, [selected, tasks]);

    async function uploadImage(file: File | undefined) {
        if (!file || inFlight.current) return;
        inFlight.current = true; setUploading(true); setError("");
        try {
            const body = new FormData(); body.set("image", file);
            const response = await fetch("/api/images/source", { method: "POST", body });
            const data = await response.json().catch(() => ({})) as { taskId?: string; imageUrl?: string; error?: string };
            if (!response.ok || !data.taskId || !data.imageUrl) throw new Error(data.error || "No se pudo subir la imagen.");
            await revalidateImageTasks();
            setSelected({ taskId: data.taskId, index: 0, imageUrl: data.imageUrl, prompt: file.name, documentId: crypto.randomUUID() });
            setPickerOpen(false);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo subir la imagen."); }
        finally { inFlight.current = false; setUploading(false); }
    }

    function openDocument(doc: SavedDocument) {
        setSelected({ taskId: doc.sourceTaskId, index: doc.sourceIndex, imageUrl: `/api/download/${encodeURIComponent(doc.sourceTaskId)}?index=${doc.sourceIndex}`, prompt: doc.title, documentId: doc.id });
        setPickerOpen(false);
    }

    function newFromOriginal(image: Pick<Selection, "taskId" | "index" | "imageUrl" | "prompt">) {
        setSelected({ ...image, documentId: crypto.randomUUID() });
        setPickerOpen(false);
    }

    async function duplicateDocument(doc: SavedDocument) {
        if (inFlight.current) return;
        inFlight.current = true; setUploading(true); setDocumentsError("");
        try {
            const response = await fetch(`/api/images/documents?id=${encodeURIComponent(doc.id)}`, { cache: "no-store" });
            const data = await response.json() as { document?: EditorDocument; error?: string };
            if (!response.ok || !data.document) throw new Error(data.error || "No se pudo abrir el archivo.");
            const id = crypto.randomUUID();
            const title = `${data.document.title.slice(0, 152)} (copia)`;
            const saved = await fetch("/api/images/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, title, sourceTaskId: doc.sourceTaskId, sourceIndex: doc.sourceIndex, history: data.document.history, expectedRevision: 0 }) });
            const result = await saved.json() as { error?: string };
            if (!saved.ok) throw new Error(result.error || "No se pudo duplicar el archivo.");
            setSelected({ taskId: doc.sourceTaskId, index: doc.sourceIndex, imageUrl: `/api/download/${encodeURIComponent(doc.sourceTaskId)}?index=${doc.sourceIndex}`, prompt: title, documentId: id });
            setPickerOpen(false);
        } catch (cause) { setDocumentsError(cause instanceof Error ? cause.message : "No se pudo duplicar el archivo."); }
        finally { inFlight.current = false; setUploading(false); }
    }

    return <>
        <ImageEditor registerBeforeLeave={registerBeforeLeave} key={selected?.documentId ?? "empty"} documentId={selected?.documentId} imageUrl={selected?.imageUrl ?? ""} taskId={selected?.taskId} index={selected?.index ?? 0} prompt={selected?.prompt} embedded onClose={onBack} onRequestImage={() => { setError(""); setPickerOpen(true); }} onOpenDocument={id => setSelected(previous => previous ? { ...previous, documentId: id } : previous)} onNewFromOriginal={() => { if (selected) newFromOriginal({ taskId: selected.taskId, index: selected.index, imageUrl: selected.imageUrl, prompt: tasks.find(task => task.task_id === selected.taskId)?.prompt || "Nueva edición" }); }} />
        {pickerOpen && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-3 text-white backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) setPickerOpen(false); }}>
            <section role="dialog" aria-modal="true" aria-label="Seleccionar imagen para editar" className="flex max-h-[min(85vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#111] shadow-2xl">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4 sm:p-5"><div><h2 className="flex items-center gap-2 text-lg font-bold"><Images className="h-5 w-5 text-[#ff4d4d]" /> Elegir imagen</h2><p className="mt-1 text-xs text-white/50">Selecciona una imagen de tu galería o sube una nueva.</p></div><div className="flex items-center gap-2"><label className="flex cursor-pointer items-center gap-2 rounded-xl bg-[#c62828] px-3 py-2 text-sm font-bold text-white hover:bg-[#a92121]"><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" disabled={uploading} onChange={(event) => { void uploadImage(event.target.files?.[0]); event.target.value = ""; }} />{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{uploading ? "Subiendo…" : "Subir imagen"}</label><button type="button" onClick={() => setPickerOpen(false)} disabled={uploading} aria-label="Cerrar galería" className="rounded-xl border border-white/15 p-2 hover:bg-white/10 disabled:opacity-40"><X className="h-5 w-5" /></button></div></header>
                <div className="flex flex-wrap gap-2 border-b border-white/10 px-4 py-3 sm:px-5"><input aria-label="Buscar imagen" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar imagen…" className="min-w-44 flex-1 rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-sm outline-none focus:border-[#ff4d4d]" /><select aria-label="Filtrar por empresa" value={folderFilter} onChange={event => setFolderFilter(event.target.value)} className="rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-sm"><option value="all">Todas las empresas</option><option value="unassigned">Sin empresa</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></div>
                <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
                    <section aria-label="Archivos de edición guardados" className="mb-6">
                        <h3 className="mb-1 text-sm font-semibold">Mis archivos de edición</h3>
                        <p className="mb-3 text-xs text-white/50">Cada archivo conserva sus propias capas y su historial. Puedes crear varios desde la misma imagen.</p>
                        {documentsError && <p role="alert" className="mb-3 text-xs text-amber-200">{documentsError}</p>}
                        <div className="grid gap-2 sm:grid-cols-2">
                            {savedDocuments.filter(doc => !search.trim() || doc.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(doc =>
                                <div key={doc.id} className="flex items-center gap-3 rounded-xl border border-white/15 bg-[#191919] p-3">
                                    <img src={`/api/download/${encodeURIComponent(doc.previewTaskId || doc.sourceTaskId)}?index=${doc.previewIndex ?? doc.sourceIndex}`} alt="" className="h-14 w-14 shrink-0 rounded object-contain" />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{doc.title}</p>
                                        <p className="text-xs text-white/50">{doc.versions} versiones · {new Date(doc.updatedAt).toLocaleString()}</p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button type="button" disabled={uploading} onClick={() => openDocument(doc)} className="text-xs font-semibold text-[#ff4d4d] hover:underline disabled:opacity-50">Abrir</button>
                                            <button type="button" disabled={uploading} onClick={() => void duplicateDocument(doc)} className="text-xs text-white/75 hover:underline disabled:opacity-50">Duplicar</button>
                                            <button type="button" disabled={uploading} onClick={() => newFromOriginal({ taskId: doc.sourceTaskId, index: doc.sourceIndex, imageUrl: `/api/download/${encodeURIComponent(doc.sourceTaskId)}?index=${doc.sourceIndex}`, prompt: tasks.find(task => task.task_id === doc.sourceTaskId)?.prompt || "Nueva edición" })} className="text-xs text-white/75 hover:underline disabled:opacity-50">Nueva desde original</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        {!savedDocuments.length && !documentsError && <p className="text-xs text-white/50">Aún no hay archivos. Selecciona una imagen para crear el primero.</p>}
                    </section>
                    <h3 className="mb-3 text-sm font-semibold">Galería de imágenes · crear archivo nuevo</h3>
                    {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
                    {isLoading ? <p className="py-12 text-center text-sm text-white/50">Cargando imágenes…</p> : images.length ?
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{images.map(image =>
                            <button key={`${image.taskId}:${image.index}`} type="button" onClick={() => newFromOriginal(image)} disabled={uploading} className="group overflow-hidden rounded-xl border border-white/10 bg-[#191919] text-left transition hover:border-[#ff4d4d]/70 disabled:opacity-50">
                                <div className="grid aspect-square place-items-center bg-[#0a0a0a]"><img src={image.imageUrl} alt="Vista previa de imagen" className="h-full max-h-full w-full object-contain" /></div>
                                <p className="truncate p-3 text-xs text-white/65">{image.prompt?.slice(0, 120) || "Imagen sin descripción"}</p>
                            </button>
                        )}</div> : <div className="rounded-xl border border-dashed border-white/15 p-12 text-center text-sm text-white/50">No hay imágenes con estos filtros. Puedes subir una nueva.</div>}
                </div>
            </section>
        </div>}
    </>;
}
