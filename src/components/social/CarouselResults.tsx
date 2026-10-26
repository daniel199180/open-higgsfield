"use client";

/* eslint-disable @next/next/no-img-element -- local, authenticated generation output */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Layers3, Loader2, Pencil, RotateCcw } from "lucide-react";
import { useImageTasks } from "@/hooks/useImageTasks";
import type { SocialProject } from "@/social/types";

export function CarouselResults() {
    const [projects, setProjects] = useState<SocialProject[]>([]);
    const [error, setError] = useState("");
    const { tasks } = useImageTasks();
    const [selectedId, setSelectedId] = useState("");

    const refresh = useCallback(async () => {
        try {
            const response = await fetch("/api/social", { cache: "no-store" });
            if (!response.ok) throw new Error("No se pudieron cargar los carruseles.");
            const data = await response.json() as { projects?: SocialProject[] };
            const next = (data.projects ?? []).filter(project => project.format === "carousel" && project.slides);
            setProjects(next);
            setSelectedId(current => new URLSearchParams(window.location.search).get("carousel") || current || next[0]?.id || "");
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudieron cargar los carruseles.");
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => { void refresh(); }, 0);
        window.addEventListener("open-higgsfield:carousel-updated", refresh);
        return () => { window.clearTimeout(timer); window.removeEventListener("open-higgsfield:carousel-updated", refresh); };
    }, [refresh]);

    const project = useMemo(() => projects.find(item => item.id === selectedId) ?? projects[0], [projects, selectedId]);
    const ordered = (project?.slides ?? []).map((slide, index) => ({ slide, index, task: tasks.find(item => item.task_id === slide.taskIds.at(-1)) }));
    const finished = ordered.filter(item => item.task?.status === "COMPLETED").length;
    const pending = ordered.filter(item => !item.task || ["FAILED", "ERROR", "CANCELLED"].includes(item.task.status ?? ""));

    return <div className="h-full overflow-y-auto pb-[310px] text-white">
        <div className="mx-auto max-w-[1300px] px-5 pt-20">
            <div className="mb-7 flex flex-wrap items-center gap-3">
                <Layers3 className="h-6 w-6 text-[#ff4d4d]" />
                <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">Carruseles</h1><p className="text-xs text-white/45">Describe tu idea abajo. La IA crea las páginas en orden y el resultado aparece aquí.</p></div>
                {projects.length > 1 && <select aria-label="Carrusel" value={project?.id ?? ""} onChange={event => { setSelectedId(event.target.value); const url = new URL(window.location.href); url.searchParams.set("carousel", event.target.value); window.history.replaceState(null, "", url); }} className="max-w-60 rounded-xl border border-white/15 bg-[#141414] px-3 py-2 text-xs text-white"><option value="">Selecciona un carrusel</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
            </div>
            {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/25 p-3 text-xs text-red-200">{error}</p>}
            {!project ? <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-white/10 text-center text-sm text-white/40">Escribe qué quieres comunicar en el cuadro de abajo para crear tu primer carrusel.</div> : <>
                <div className="mb-5 flex justify-end"><div className="max-w-[min(42rem,90%)] rounded-[22px] rounded-br-md border border-[#ff4d4d]/20 bg-[#ff4d4d]/10 px-5 py-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[#ff4d4d]">Tu mensaje</p><p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{project.brief}</p></div></div>
                <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[.03] p-4">
                    <div className="min-w-0 flex-1"><h2 className="truncate text-base font-semibold">{project.name}</h2><p className="mt-1 text-xs text-white/50">{finished === ordered.length ? "Carrusel listo" : `${finished}/${ordered.length} páginas listas`} · {project.aspectRatio}</p></div>
                    {pending.length > 0 && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("open-higgsfield:carousel-resume", { detail: { projectId: project.id } }))} className="inline-flex items-center gap-2 rounded-xl border border-[#ff4d4d]/35 px-3 py-2 text-xs font-semibold text-[#ff4d4d]"><RotateCcw size={14} />Continuar {pending.length} pendiente{pending.length === 1 ? "" : "s"}</button>}
                    {finished === ordered.length && ordered.length > 0 && <><a href={`/api/social/carousels/${project.id}/export?format=zip`} className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-xs"><Download size={14} />ZIP</a><a href={`/api/social/carousels/${project.id}/export?format=pdf`} className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-xs"><Download size={14} />PDF</a></>}
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{ordered.map(({ slide, index, task }) => <article key={slide.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#101010]"><div className="flex items-center justify-between gap-2 px-4 py-3 text-xs"><span className="font-semibold text-[#ff4d4d]">{index + 1}. {slide.role}</span><span className="text-white/45">{task?.status === "COMPLETED" ? "Lista" : task ? ["FAILED", "ERROR", "CANCELLED"].includes(task.status ?? "") ? "Error" : task.status === "CREATED" ? "En cola" : "Generando…" : "Pendiente"}</span></div><div className="grid min-h-44 place-items-center bg-black/30" style={{ aspectRatio: project.aspectRatio?.replace(":", "/") || "4/5" }}>{task?.status === "COMPLETED" ? <img src={`/api/download/${encodeURIComponent(task.task_id)}?index=0`} alt={`Página ${index + 1} del carrusel`} className="h-full w-full object-contain" /> : task && !["FAILED", "ERROR", "CANCELLED"].includes(task.status ?? "") ? <Loader2 className="h-5 w-5 animate-spin text-[#ff4d4d]" /> : <span className="px-3 text-center text-xs text-white/40">{task?.error_message || "Esperando generación"}</span>}</div>{task?.status === "COMPLETED" && <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs"><a href={`/api/download/${encodeURIComponent(task.task_id)}?index=0`} download className="text-white/60 hover:text-white">Descargar</a><a href={`?workspace=editor&task=${encodeURIComponent(task.task_id)}&index=0`} className="inline-flex items-center gap-1.5 font-semibold text-[#ff4d4d] hover:text-[#ff7474]"><Pencil size={13} />Editar texto y logo</a></div>}</article>)}</div>
            </>}
        </div>
    </div>;
}
