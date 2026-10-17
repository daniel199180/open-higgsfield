import "server-only";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { carouselPrompt } from "./carousel";
import { brandImageAssetIds } from "./brand";
import { characterIdentityPrompt } from "./characters";
import type { ImageModelCapability } from "@/models/capabilities/image";
import type { BrandSystem, SocialProject } from "./types";

export function finalCarouselPrompt(project: SocialProject, slideId: string, brand: BrandSystem) {
    const slide = project.slides?.find(item => item.id === slideId);
    if (!slide) throw new WorkflowError("No se encontró la diapositiva.", 404);
    return [carouselPrompt(project, slide, brand), project.character ? characterIdentityPrompt(project.character) : ""].filter(Boolean).join("\n\n");
}

/** Validate the exact prompt and inputs that will be sent for every page. */
export function validateCarouselProject(project: SocialProject, brand: BrandSystem, model: ImageModelCapability) {
    const promptMax = model.prompt_max ?? 10_000;
    const slides = project.slides ?? [];
    const longest = slides.reduce<{ length: number; index: number }>((current, slide, index) => {
        const length = finalCarouselPrompt(project, slide.id, brand).length;
        return length > current.length ? { length, index } : current;
    }, { length: 0, index: 0 });
    if (longest.length > promptMax) {
        throw new WorkflowError(`La página ${longest.index + 1} supera el límite del modelo (${longest.length}/${promptMax} caracteres). Acorta las reglas de marca o el texto antes de generar.`, 400);
    }
    const needsImages = brandImageAssetIds(brand).length > 0 || Boolean(project.character?.referenceAssetIds.length);
    if (needsImages && !model.media_slots.some(slot => slot.kind === "image")) {
        throw new WorkflowError("El sistema de diseño o el personaje usa imágenes de referencia y este modelo no las declara compatibles. Elige un modelo que admita referencias.", 400);
    }
    return { promptMax, longestPromptLength: longest.length };
}

export async function prepareCarouselSlide(projectId: string, slideId: string, modelId: string, ratio: string, resolution: string, model: ImageModelCapability) {
    const store = workflowStore();
    const project = await store.read<SocialProject>(`social:${projectId}`);
    if (!project || project.format !== "carousel" || !project.slides) throw new WorkflowError("No se encontró el carrusel.", 404);
    if (project.modelId !== modelId || project.aspectRatio !== ratio || project.resolution !== resolution) throw new WorkflowError("La configuración ya no coincide con el carrusel guardado.", 409);
    const brand = await store.read<BrandSystem>(`brand:${project.brandId}`);
    if (!brand) throw new WorkflowError("El sistema de diseño ya no está disponible.", 409);
    validateCarouselProject(project, brand, model);
    return { prompt: finalCarouselPrompt(project, slideId, brand), brand, character: project.character, companyId: project.companyId };
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
