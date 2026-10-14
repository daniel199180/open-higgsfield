import "server-only";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { carouselPrompt } from "./carousel";
import type { BrandSystem, SocialProject } from "./types";

export async function prepareCarouselSlide(projectId: string, slideId: string, modelId: string, ratio: string, resolution: string) {
    const store = workflowStore();
    const project = await store.read<SocialProject>(`social:${projectId}`);
    if (!project || project.format !== "carousel" || !project.slides) throw new WorkflowError("No se encontró el carrusel.", 404);
    const slide = project.slides.find(item => item.id === slideId);
    if (!slide) throw new WorkflowError("No se encontró la diapositiva.", 404);
    if (project.modelId !== modelId || project.aspectRatio !== ratio || project.resolution !== resolution) throw new WorkflowError("La configuración ya no coincide con el carrusel guardado.", 409);
    const brand = await store.read<BrandSystem>(`brand:${project.brandId}`);
    if (!brand) throw new WorkflowError("El sistema de diseño ya no está disponible.", 409);
    return { prompt: carouselPrompt(project, slide, brand), brand, character: project.character, companyId: project.companyId };
}

export async function attachCarouselTask(projectId: string, slideId: string, taskId: string) {
    return workflowStore().transaction(docs => {
        const project = docs.get(`social:${projectId}`) as SocialProject | undefined;
        if (!project?.slides) throw new WorkflowError("No se encontró el carrusel.", 404);
        const slides = project.slides.map(slide => slide.id === slideId ? { ...slide, taskIds: slide.taskIds.includes(taskId) ? slide.taskIds : [...slide.taskIds, taskId].slice(-10) } : slide);
        if (!slides.some(slide => slide.id === slideId)) throw new WorkflowError("No se encontró la diapositiva.", 404);
        const next: SocialProject = { ...project, slides, taskIds: slides.flatMap(slide => slide.taskIds.slice(-1)), status: "generating", updatedAt: Date.now() };
        docs.set(`social:${projectId}`, next);
        return next;
    });
}
