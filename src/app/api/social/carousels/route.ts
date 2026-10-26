import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { findCapability } from "@/providers/catalog";
import type { ImageModelCapability } from "@/models/capabilities/image";
import { carouselRoles, imageRatios, imageResolutions } from "@/social/carousel";
import { validateCarouselProject } from "@/social/carousel-server";
import { isCarouselModel } from "@/social/carousel-models";
import type { BrandSystem, CarouselSlide, SocialProject } from "@/social/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { getTask, initStore } from "@/lib/task-store";
import { getEditVariant } from "@/models/capabilities/image-helpers";
import type { Character } from "@/social/types";
import { characterSnapshot } from "@/social/characters";
import { requireCompany } from "@/library/server";

export const runtime = "nodejs";

const slideSchema = z.object({ id: z.uuid(), role: z.string().trim().min(1).max(50), title: z.string().trim().max(200), body: z.string().trim().max(500), visualPrompt: z.string().trim().max(2000) }).strict();
const ratioSchema = z.string().regex(/^\d{1,2}:\d{1,2}$/).refine(value => {
    const [w, h] = value.split(":").map(Number);
    return w > 0 && h > 0 && h / w <= 3.5 && w / h <= 3.5;
});
const commandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), name: z.string().trim().min(1).max(100), brief: z.string().trim().min(5).max(2000), brandId: z.uuid(), companyId: z.uuid().optional(), characterId: z.uuid().optional(), modelId: z.string().min(1).max(500), aspectRatio: ratioSchema, resolution: z.string().max(30), slideCount: z.number().int().min(2).max(10), slidePrompts: z.array(z.string().trim().max(2000)).max(10).optional(), language: z.enum(["Español", "Português (Brasil)", "English"]), autoStory: z.boolean().optional(), fieldValues: z.record(z.string().max(80), z.union([z.string().max(200), z.number(), z.boolean()])).optional() }).strict(),
    z.object({ action: z.literal("save"), id: z.uuid(), name: z.string().trim().min(1).max(100), brief: z.string().trim().min(5).max(2000), modelId: z.string().min(1).max(500), aspectRatio: ratioSchema, resolution: z.string().max(30), slides: z.array(slideSchema).min(2).max(10) }).strict(),
    z.object({ action: z.literal("variant"), sourceId: z.uuid(), modelId: z.string().min(1).max(500), aspectRatio: ratioSchema, resolution: z.string().max(30) }).strict(),
]);

async function checkModel(modelId: string, ratio: string, resolution: string) {
    const model = await findCapability("image", modelId) as ImageModelCapability | undefined;
    if (!model) throw new WorkflowError("Selecciona un modelo de imagen disponible.", 400);
    if (!isCarouselModel(model)) throw new WorkflowError("Para carruseles selecciona GPT Image o Nano Banana de OpenRouter o APIMart.", 400);
    const ratios = imageRatios(model);
    if (ratios.length > 0 && !ratios.includes(ratio)) throw new WorkflowError("El modelo no admite esa proporción.", 400);
    const resolutions = imageResolutions(model);
    if (resolutions.length > 0 && !resolutions.includes(resolution)) throw new WorkflowError("El modelo no admite esa resolución.", 400);
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("social-carousels", 60); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = commandSchema.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 32 * 1024)).toString("utf8")));
        if (input.action === "create") await requireCompany(input.companyId);
        await checkModel(input.modelId, input.aspectRatio, input.resolution);
        const selectedModel = await findCapability("image", input.modelId) as ImageModelCapability;
        if (input.action === "variant") {
            const model = await findCapability("image", input.modelId) as ImageModelCapability;
            if (!model.media_slots.some(slot => slot.kind === "image" && !slot.required) && !getEditVariant(model)?.slots.some(slot => slot.kind === "image")) throw new WorkflowError("Para adaptar el mismo carrusel, el modelo debe admitir una imagen de referencia.", 400);
            await initStore();
        }
        const store = workflowStore();
        const saved = await store.transaction(docs => {
            const now = Date.now();
            if (input.action === "variant") {
                const source = docs.get(`social:${input.sourceId}`) as SocialProject | undefined;
                if (!source?.slides || source.format !== "carousel") throw new WorkflowError("No se encontró el carrusel original.", 404);
                if (source.aspectRatio === input.aspectRatio) throw new WorkflowError("Elige una proporción diferente para la variante.", 400);
                if ([...docs.keys()].filter(key => key.startsWith("social:")).length >= 500) throw new WorkflowError("El historial de proyectos está lleno.", 409);
                const slides: CarouselSlide[] = source.slides.map(slide => {
                    const sourceTaskId = slide.taskIds.at(-1);
                    const task = sourceTaskId ? getTask(sourceTaskId) : undefined;
                    if (!task || task.media_type !== "image" || task.status !== "COMPLETED") throw new WorkflowError("Termina todas las páginas originales antes de adaptarlas.", 409);
                    return { id: crypto.randomUUID(), role: slide.role, title: slide.title, body: slide.body, visualPrompt: slide.visualPrompt, taskIds: [], sourceTaskId };
                });
                const project: SocialProject = { ...source, id: crypto.randomUUID(), name: `${source.name} · ${input.aspectRatio}`.slice(0, 100), modelId: input.modelId, aspectRatio: input.aspectRatio, resolution: input.resolution, slides, slideCount: slides.length, taskIds: [], status: "draft", sourceProjectId: source.id, createdAt: now, updatedAt: now };
                docs.set(`social:${project.id}`, project);
                return project;
            }
            if (input.action === "create") {
                if (input.slidePrompts && input.slidePrompts.length !== input.slideCount) throw new WorkflowError("La cantidad de prompts debe coincidir con la cantidad de páginas.", 400);
                if (!docs.has(`brand:${input.brandId}`)) throw new WorkflowError("Selecciona un sistema de diseño válido.", 400);
                const selectedCharacter = input.characterId ? docs.get(`character:${input.characterId}`) as Character | undefined : undefined;
                if (input.characterId && (!selectedCharacter || selectedCharacter.archivedAt)) throw new WorkflowError("El personaje ya no está disponible.", 400);
                if ([...docs.keys()].filter(key => key.startsWith("social:")).length >= 500) throw new WorkflowError("El historial de proyectos está lleno.", 409);
                const slides: CarouselSlide[] = carouselRoles(input.slideCount).map((role, index) => ({ id: crypto.randomUUID(), role, title: "", body: "", visualPrompt: input.slidePrompts?.[index] ?? "", taskIds: [] }));
                const brand = docs.get(`brand:${input.brandId}`) as BrandSystem;
                const project: SocialProject = { id: crypto.randomUUID(), name: input.name, brandId: input.brandId, companyId: input.companyId, character: selectedCharacter ? characterSnapshot(selectedCharacter) : undefined, format: "carousel", language: input.language, brief: input.brief, modelId: input.modelId, aspectRatio: input.aspectRatio, resolution: input.resolution, fieldValues: input.fieldValues ?? {}, slideCount: slides.length, taskIds: [], slides, autoStory: input.autoStory ?? false, status: "draft", createdAt: now, updatedAt: now };
                validateCarouselProject(project, brand, selectedModel);
                docs.set(`social:${project.id}`, project);
                return project;
            }
            const previous = docs.get(`social:${input.id}`) as SocialProject | undefined;
            if (!previous || previous.format !== "carousel" || !previous.slides) throw new WorkflowError("No se encontró el carrusel.", 404);
            if (previous.taskIds.length > 0 && (previous.modelId !== input.modelId || previous.aspectRatio !== input.aspectRatio || previous.resolution !== input.resolution)) throw new WorkflowError("Para cambiar el modelo o formato de un carrusel generado, crea una variante nueva.", 409);
            const existing = new Map(previous.slides.map(slide => [slide.id, slide]));
            if (input.slides.length !== previous.slides.length || new Set(input.slides.map(slide => slide.id)).size !== input.slides.length || input.slides.some(slide => !existing.has(slide.id))) throw new WorkflowError("El orden de diapositivas no es válido.", 400);
            const slides = input.slides.map(slide => ({ ...slide, taskIds: existing.get(slide.id)!.taskIds, sourceTaskId: existing.get(slide.id)!.sourceTaskId }));
            const project: SocialProject = { ...previous, name: input.name, brief: input.brief, modelId: input.modelId, aspectRatio: input.aspectRatio, resolution: input.resolution, slides, taskIds: slides.flatMap(slide => slide.taskIds.slice(-1)), updatedAt: now };
            docs.set(`social:${project.id}`, project);
            return project;
        });
        return NextResponse.json({ project: saved }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Revisa los campos del carrusel." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo guardar el carrusel." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
