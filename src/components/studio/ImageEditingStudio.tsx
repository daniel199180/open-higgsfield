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

export function ImageEditingStudio({ onBack, registerBeforeLeave }: { onBack: () => void; registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void }) {
    const { tasks, isLoading } = useImageTasks();
    const { companies } = useCompanySelection();
    const [folderFilter, setFolderFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<Selection | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const [savedDocuments, setSavedDocuments] = useState<Array<Omit<EditorDocument, "history"> & { versions: number }>>([]);
    const [documentsError, setDocumentsError] = useState("");
    const inFlight = useRef(false);
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

    async function uploadImage(file: File | undefined) {
        if (!file || inFlight.current) return;
        inFlight.current = true; setUploading(true); setError("");
        try {
            const body = new FormData(); body.set("image", file);
            const response = await fetch("/api/images/source", { method: "POST", body });
            const data = await response.json().catch(() => ({})) as { taskId?: string; imageUrl?: string; error?: string };
            if (!response.ok || !data.taskId || !data.imageUrl) throw new Error(data.error || "No se pudo subir la imagen.");
            await revalidateImageTasks();
            setSelected({ taskId: data.taskId, index: 0, imageUrl: data.imageUrl, prompt: file.name });
            setPickerOpen(false);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo subir la imagen."); }
        finally { inFlight.current = false; setUploading(false); }
    }

    return <>
        <ImageEditor registerBeforeLeave={registerBeforeLeave} key={selected?.documentId ?? (selected ? `${selected.taskId}:${selected.index}` : "empty")} documentId={selected?.documentId} imageUrl={selected?.imageUrl ?? ""} taskId={selected?.taskId} index={selected?.index ?? 0} prompt={selected?.prompt} embedded onClose={onBack} onRequestImage={() => { setError(""); setPickerOpen(true); }} />
        {pickerOpen && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-3 text-white backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) setPickerOpen(false); }}>
            <section role="dialog" aria-modal="true" aria-label="Seleccionar imagen para editar" className="flex max-h-[min(85vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#111] shadow-2xl">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4 sm:p-5"><div><h2 className="flex items-center gap-2 text-lg font-bold"><Images className="h-5 w-5 text-[#ff4d4d]" /> Elegir imagen</h2><p className="mt-1 text-xs text-white/50">Selecciona una imagen de tu galería o sube una nueva.</p></div><div className="flex items-center gap-2"><label className="flex cursor-pointer items-center gap-2 rounded-xl bg-[#c62828] px-3 py-2 text-sm font-bold text-white hover:bg-[#a92121]"><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" disabled={uploading} onChange={(event) => { void uploadImage(event.target.files?.[0]); event.target.value = ""; }} />{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{uploading ? "Subiendo…" : "Subir imagen"}</label><button type="button" onClick={() => setPickerOpen(false)} disabled={uploading} aria-label="Cerrar galería" className="rounded-xl border border-white/15 p-2 hover:bg-white/10 disabled:opacity-40"><X className="h-5 w-5" /></button></div></header>
                <div className="flex flex-wrap gap-2 border-b border-white/10 px-4 py-3 sm:px-5"><input aria-label="Buscar imagen" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar imagen…" className="min-w-44 flex-1 rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-sm outline-none focus:border-[#ff4d4d]" /><select aria-label="Filtrar por empresa" value={folderFilter} onChange={event => setFolderFilter(event.target.value)} className="rounded-xl border border-white/15 bg-[#191919] px-3 py-2 text-sm"><option value="all">Todas las empresas</option><option value="unassigned">Sin empresa</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></div>
                <div className="min-h-0 overflow-y-auto p-4 sm:p-5"><section aria-label="Ediciones guardadas" className="mb-6"><h3 className="mb-3 text-sm font-semibold">Ediciones guardadas · continuar después</h3>{documentsError && <p role="alert" className="text-xs text-amber-200">{documentsError}</p>}<div className="grid gap-2 sm:grid-cols-2">{savedDocuments.filter(doc => !search.trim() || doc.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(doc => <button key={doc.id} type="button" disabled={uploading} onClick={() => { setSelected({ taskId: doc.sourceTaskId, index: doc.sourceIndex, imageUrl: `/api/download/${encodeURIComponent(doc.sourceTaskId)}?index=${doc.sourceIndex}`, prompt: doc.title, documentId: doc.id }); setPickerOpen(false); }} className="flex items-center gap-3 rounded-xl border border-white/15 bg-[#191919] p-3 text-left hover:border-[#ff4d4d]"><img src={`/api/download/${encodeURIComponent(doc.sourceTaskId)}?index=${doc.sourceIndex}`} alt="" className="h-14 w-14 rounded object-contain" /><span className="min-w-0"><span className="block truncate text-sm">{doc.title}</span><span className="block text-xs text-white/50">{doc.versions} cambios · {new Date(doc.updatedAt).toLocaleString()}</span><span className="text-xs text-[#ff4d4d]">Continuar edición →</span></span></button>)}</div>{!savedDocuments.length && !documentsError && <p className="text-xs text-white/50">Tus ediciones se guardarán automáticamente aquí.</p>}</section><h3 className="mb-3 text-sm font-semibold">Galería de imágenes</h3>{error && <p role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}{isLoading ? <p className="py-12 text-center text-sm text-white/50">Cargando imágenes…</p> : images.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{images.map((image) => <button key={`${image.taskId}:${image.index}`} type="button" onClick={() => { setSelected(image); setPickerOpen(false); }} disabled={uploading} className="group overflow-hidden rounded-xl border border-white/10 bg-[#191919] text-left transition hover:border-[#ff4d4d]/70 disabled:opacity-50"><div className="grid aspect-square place-items-center bg-[#0a0a0a]"><img src={image.imageUrl} alt="Vista previa de imagen" className="h-full max-h-full w-full object-contain" /></div><p className="truncate p-3 text-xs text-white/65">{image.prompt?.slice(0, 120) || "Imagen sin descripción"}</p></button>)}</div> : <div className="rounded-xl border border-dashed border-white/15 p-12 text-center text-sm text-white/50">No hay imágenes con estos filtros. Puedes subir una nueva.</div>}</div>
            </section>
        </div>}
    </>;
}
