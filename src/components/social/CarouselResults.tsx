"use client";

/* eslint-disable @next/next/no-img-element -- local, authenticated generation output */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Layers3, Loader2, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { useImageTasks } from "@/hooks/useImageTasks";
import type { ImageModelCapability } from "@/models/capabilities/image";
import { imageRatios, imageResolutions } from "@/social/carousel";
import { isCarouselModel } from "@/social/carousel-models";
import type { SocialProject } from "@/social/types";

type GenerationConfig = { projectId: string; modelId: string; resolution: string };

function compatibleModels(project: SocialProject | undefined, models: ImageModelCapability[]) {
    if (!project) return [];
    return models.filter(model => {
        const ratios = imageRatios(model);
        return ratios.length === 0 || ratios.includes(project.aspectRatio ?? "");
    });
}

function configFor(project: SocialProject | undefined, models: ImageModelCapability[]): GenerationConfig {
    if (!project) return { projectId: "", modelId: "", resolution: "" };
    const available = compatibleModels(project, models);
    const model = available.find(item => item.id === project.modelId) ?? available[0];
    const resolutions = model ? imageResolutions(model) : [];
    const resolution = project.resolution && (resolutions.length === 0 || resolutions.includes(project.resolution))
        ? project.resolution
        : model?.size_ui?.default_resolution ?? resolutions[0] ?? "";
    return { projectId: project.id, modelId: model?.id ?? "", resolution };
}

function providerName(provider: ImageModelCapability["provider"]) {
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "apimart") return "APIMart";
    return provider;
}

export function CarouselResults() {
    const [projects, setProjects] = useState<SocialProject[]>([]);
    const [models, setModels] = useState<ImageModelCapability[]>([]);
    const [error, setError] = useState("");
    const { tasks } = useImageTasks();
    const [selectedId, setSelectedId] = useState("");
    const [config, setConfig] = useState<GenerationConfig>({ projectId: "", modelId: "", resolution: "" });
    const [actionKey, setActionKey] = useState("");

    const refresh = useCallback(async () => {
        try {
            const [socialResponse, catalogResponse] = await Promise.all([
                fetch("/api/social", { cache: "no-store" }),
                fetch("/api/catalog?mediaType=image", { cache: "no-store" }),
            ]);
            if (!socialResponse.ok) throw new Error("No se pudieron cargar los carruseles.");
            const data = await socialResponse.json() as { projects?: SocialProject[] };
            const catalog = catalogResponse.ok ? await catalogResponse.json() as { models?: ImageModelCapability[] } : { models: [] };
            const nextModels = (catalog.models ?? []).filter(isCarouselModel);
            const next = (data.projects ?? []).filter(project => project.format === "carousel" && project.slides);
            const requestedId = new URLSearchParams(window.location.search).get("carousel") || "";
            const nextSelectedId = next.some(item => item.id === requestedId) ? requestedId : selectedId && next.some(item => item.id === selectedId) ? selectedId : next[0]?.id || "";
            const nextProject = next.find(item => item.id === nextSelectedId);
            setProjects(next);
            setModels(nextModels);
            setSelectedId(nextSelectedId);
            setConfig(current => current.projectId === nextProject?.id ? current : configFor(nextProject, nextModels));
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudieron cargar los carruseles.");
        }
    }, [selectedId]);

    useEffect(() => {
        const timer = window.setTimeout(() => { void refresh(); }, 0);
        window.addEventListener("open-higgsfield:carousel-updated", refresh);
        return () => { window.clearTimeout(timer); window.removeEventListener("open-higgsfield:carousel-updated", refresh); };
    }, [refresh]);

    const project = useMemo(() => projects.find(item => item.id === selectedId) ?? projects[0], [projects, selectedId]);
    const availableModels = useMemo(() => compatibleModels(project, models), [project, models]);
    const selectedModel = availableModels.find(item => item.id === config.modelId);
    const resolutions = selectedModel ? imageResolutions(selectedModel) : [];
    const ordered = (project?.slides ?? []).map((slide, index) => ({ slide, index, task: tasks.find(item => item.task_id === slide.taskIds.at(-1)) }));
    const finished = ordered.filter(item => item.task?.status === "COMPLETED").length;
    const pending = ordered.filter(item => !item.task || ["FAILED", "ERROR", "CANCELLED"].includes(item.task.status ?? ""));

    function selectProject(id: string) {
        const next = projects.find(item => item.id === id);
        setSelectedId(id);
        setConfig(configFor(next, models));
        const url = new URL(window.location.href);
        url.searchParams.set("carousel", id);
        window.history.replaceState(null, "", url);
    }

    function selectModel(id: string) {
        const model = availableModels.find(item => item.id === id);
        const nextResolutions = model ? imageResolutions(model) : [];
        const resolution = project?.resolution && (nextResolutions.length === 0 || nextResolutions.includes(project.resolution))
            ? project.resolution
            : model?.size_ui?.default_resolution ?? nextResolutions[0] ?? "";
        setConfig(current => ({ ...current, modelId: id, resolution }));
    }

    async function generate(slideId?: string, regenerateAll = false) {
        if (!project || !config.modelId) { setError("Selecciona una API y un modelo disponible."); return; }
        if (regenerateAll && !window.confirm(`¿Regenerar las ${ordered.length} páginas? Se enviará una nueva solicitud por cada página y las versiones actuales se conservarán.`)) return;
        const key = regenerateAll ? "all" : slideId || "pending";
        setActionKey(key);
        setError("");
        try {
            const response = await fetch("/api/social/carousels", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "configure", id: project.id, modelId: config.modelId, resolution: config.resolution }),
            });
            const value = await response.json().catch(() => ({})) as { project?: SocialProject; error?: string };
            if (!response.ok || !value.project) throw new Error(value.error || "No se pudo guardar el modelo del carrusel.");
            setProjects(current => current.map(item => item.id === value.project!.id ? value.project! : item));
            window.dispatchEvent(new CustomEvent("open-higgsfield:carousel-resume", { detail: { projectId: project.id, ...(slideId ? { slideId } : {}), ...(regenerateAll ? { regenerateAll: true } : {}) } }));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudo iniciar la generación.");
        } finally {
            setActionKey("");
        }
    }

    return <div className="h-full overflow-y-auto pb-[310px] text-white">
        <div className="mx-auto max-w-[1300px] px-5 pt-20">
            <div className="mb-7 flex flex-wrap items-center gap-3">
                <Layers3 className="h-6 w-6 text-[#ff4d4d]" />
                <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">Carruseles</h1><p className="text-xs text-white/45">Continúa pendientes o regenera una página con la API y el modelo que elijas.</p></div>
                {projects.length > 1 && <select aria-label="Carrusel" value={project?.id ?? ""} onChange={event => selectProject(event.target.value)} className="max-w-60 rounded-xl border border-white/15 bg-[#141414] px-3 py-2 text-xs text-white"><option value="">Selecciona un carrusel</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
            </div>
            {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/25 p-3 text-xs text-red-200">{error}</p>}
            {!project ? <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-white/10 text-center text-sm text-white/40">Escribe qué quieres comunicar en el cuadro de abajo para crear tu primer carrusel.</div> : <>
                <div className="mb-5 flex justify-end"><div className="max-w-[min(42rem,90%)] rounded-[22px] rounded-br-md border border-[#ff4d4d]/20 bg-[#ff4d4d]/10 px-5 py-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[#ff4d4d]">Tu mensaje</p><p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{project.brief}</p></div></div>
                <div className="mb-5 rounded-2xl border border-white/10 bg-white/[.03] p-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1"><h2 className="truncate text-base font-semibold">{project.name}</h2><p className="mt-1 text-xs text-white/50">{finished === ordered.length ? "Carrusel listo" : `${finished}/${ordered.length} páginas listas`} · {project.aspectRatio}</p></div>
                        {pending.length > 0 && <button type="button" disabled={!!actionKey || !config.modelId} onClick={() => void generate()} className="inline-flex items-center gap-2 rounded-xl border border-[#ff4d4d]/35 px-3 py-2 text-xs font-semibold text-[#ff4d4d] disabled:opacity-40">{actionKey === "pending" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}Continuar {pending.length} pendiente{pending.length === 1 ? "" : "s"}</button>}
                        {ordered.length > 0 && <button type="button" disabled={!!actionKey || !config.modelId} onClick={() => void generate(undefined, true)} className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-white/70 hover:border-[#ff4d4d]/35 hover:text-white disabled:opacity-40">{actionKey === "all" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}Regenerar todo</button>}
                        {finished === ordered.length && ordered.length > 0 && <><a href={`/api/social/carousels/${project.id}/export?format=zip`} className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-xs"><Download size={14} />ZIP</a><a href={`/api/social/carousels/${project.id}/export?format=pdf`} className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-xs"><Download size={14} />PDF</a></>}
                    </div>
                    <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 md:grid-cols-[minmax(0,1fr)_220px]">
                        <label className="text-[11px] font-semibold text-white/55">API y modelo para continuar o regenerar<select aria-label="API y modelo del carrusel" value={config.modelId} onChange={event => selectModel(event.target.value)} className="mt-2 w-full rounded-xl border border-white/15 bg-[#141414] px-3 py-2.5 text-xs text-white"><option value="">Selecciona API y modelo</option>{availableModels.map(model => <option key={model.id} value={model.id}>{providerName(model.provider)} · {model.label}</option>)}</select></label>
                        {resolutions.length > 0 && <label className="text-[11px] font-semibold text-white/55">Resolución<select aria-label="Resolución del carrusel" value={config.resolution} onChange={event => setConfig(current => ({ ...current, resolution: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/15 bg-[#141414] px-3 py-2.5 text-xs text-white">{resolutions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
                    </div>
                    <p className="mt-2 text-[10px] text-white/35">Las páginas listas se conservan. La selección se aplica sólo a páginas pendientes o regeneradas.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{ordered.map(({ slide, index, task }) => {
                    const failed = !!task && ["FAILED", "ERROR", "CANCELLED"].includes(task.status ?? "");
                    const completed = task?.status === "COMPLETED";
                    const active = !!task && !completed && !failed;
                    return <article key={slide.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#101010]"><div className="flex items-center justify-between gap-2 px-4 py-3 text-xs"><span className="font-semibold text-[#ff4d4d]">{index + 1}. {slide.role}</span><span className="text-white/45">{completed ? "Lista" : failed ? "Error" : active ? task?.status === "CREATED" ? "En cola" : "Generando…" : "Pendiente"}</span></div><div className="grid min-h-44 place-items-center bg-black/30" style={{ aspectRatio: project.aspectRatio?.replace(":", "/") || "4/5" }}>{completed ? <img src={`/api/download/${encodeURIComponent(task.task_id)}?index=0`} alt={`Página ${index + 1} del carrusel`} className="h-full w-full object-contain" /> : active ? <Loader2 className="h-5 w-5 animate-spin text-[#ff4d4d]" /> : <span className="px-3 text-center text-xs text-white/40">{task?.error_message || "Esperando generación"}</span>}</div><div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs">{completed ? <><a href={`/api/download/${encodeURIComponent(task.task_id)}?index=0`} download className="text-white/60 hover:text-white">Descargar</a><a href={`?workspace=editor&task=${encodeURIComponent(task.task_id)}&index=0`} className="inline-flex items-center gap-1.5 font-semibold text-[#ff4d4d] hover:text-[#ff7474]"><Pencil size={13} />Editar texto y logo</a></> : <span className="text-white/35">{failed ? "Puedes reintentar esta página" : active ? "Generación en curso" : "Lista para generar"}</span>}{!active && <button type="button" disabled={!!actionKey || !config.modelId} onClick={() => void generate(slide.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 font-semibold text-white/70 hover:border-[#ff4d4d]/40 hover:text-white disabled:opacity-40">{actionKey === slide.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{completed ? "Regenerar" : failed ? "Reintentar" : "Generar"}</button>}</div></article>;
                })}</div>
            </>}
        </div>
    </div>;
}
