import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { generationEndpoint } from "@/lib/generation-request";
import { submitGeneration } from "@/lib/generation-service";
import { editGuideForOpenRouter, ImageEditInputError, maskForImageEdit, normalizeImageEditInput, parseImageEditComments, persistImageEditSource, taskImageForEdit } from "@/lib/image-edit-source";
import { OPENAI_EDIT_MODELS } from "@/lib/openai-edit-models";
import { supportsOpenRouterEditOptions, supportedOpenRouterEditRatios } from "@/lib/openrouter-edit-models";
import { OUTPAINT_RATIOS, planOutpaint, type OutpaintPadding, type OutpaintRatio } from "@/lib/image-outpaint";
import { finishOutpaint, makeOutpaintGuide } from "@/lib/image-outpaint-server";
import { authorizeRequest, securityError } from "@/lib/api-security";
import { publicErrorMessage } from "@/lib/public-error";
import { getTask, saveTasks } from "@/lib/task-store";
import { saveDownload } from "@/lib/upload";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { getCatalog } from "@/providers/catalog";
import { providerFetch } from "@/providers/secure-fetch";
import { providerImageReference } from "@/lib/image-reference";

export const runtime = "nodejs";
export const maxDuration = 300;

const ratios = ["auto", "1:1", "3:2", "2:3"] as const;
const qualities = ["low", "medium", "high"] as const;
type EditorProvider = "openrouter" | "openai" | "google-ai-studio" | "google-vertex" | "vercel-ai-gateway" | "higgsfield" | "api-market" | "apimart";
const EDITOR_PROVIDERS: readonly EditorProvider[] = ["openrouter", "openai", "google-ai-studio", "google-vertex", "vercel-ai-gateway", "higgsfield", "api-market", "apimart"];

type EditorModel = {
    id: string;
    label: string;
    provider: EditorProvider;
    providerModelId: string;
    connectionId: string;
    aspectRatios: string[];
    supportsExpand: boolean;
    supportsMask: boolean;
};

function runtimeEditorId(provider: "openai", connectionId: string, modelId: string): string {
    return `${provider}:image:${encodeURIComponent(connectionId)}:${encodeURIComponent(modelId)}`;
}

function openAiCapabilities(connection: ProviderConnection): ModelCapabilities[] {
    return OPENAI_EDIT_MODELS.map((model, index) => ({
        id: runtimeEditorId("openai", connection.id, model.id),
        label: model.label,
        family: "OpenAI Images",
        variant: model.id,
        group: "OpenAI",
        category: "Edit",
        provider: "openai",
        provider_model_id: model.id,
        provider_connection_id: connection.id,
        provider_mode: "native-image",
        prompt_required: true,
        duration: false,
        aspect_ratio: { options: [["Auto", "auto"], ["Cuadrado", "1:1"], ["Horizontal", "3:2"], ["Vertical", "2:3"]], default: ["Auto", "auto"] },
        size: { options: [["Automático", "auto"], ["1024 × 1024", "1024x1024"], ["1536 × 1024", "1536x1024"], ["1024 × 1536", "1024x1536"]], default: ["Automático", "auto"] },
        resolution_variant: false,
        negative_prompt: false,
        cfg_scale: false,
        style: false,
        shot_type: false,
        prompt_expansion: false,
        elements: false,
        media_slots: [{ id: "source", label: "Imagen original", kind: "image", required: true }, { id: "reference", label: "Referencia", kind: "image", multiple: true }],
        custom_fields: [{ id: "quality", label: "Calidad", type: "select", options: [...qualities], default: "high" }],
        sort_key: 8000 - index,
    }));
}

function isEditorCapability(capability: ModelCapabilities): capability is ModelCapabilities & { provider: EditorProvider; provider_model_id: string; provider_connection_id: string } {
    return !!capability.provider && EDITOR_PROVIDERS.includes(capability.provider as EditorProvider)
        && capability.provider_mode !== "video"
        && (capability.media_slots.some((slot) => slot.kind === "image") || capability.id.includes(":image:"))
        && typeof capability.provider_model_id === "string" && capability.provider_model_id.length > 0
        && typeof capability.provider_connection_id === "string" && capability.provider_connection_id.length > 0;
}

function editorModel(capability: ModelCapabilities): EditorModel {
    const provider = capability.provider as EditorProvider;
    const customRatioField = capability.custom_fields.find((field) => field.id === "aspect_ratio");
    const aspectRatios = capability.aspect_ratio !== false
        ? capability.aspect_ratio.options?.map(([, value]) => value) ?? []
        : customRatioField?.options ?? [];
    const providerLabel = provider === "api-market" ? "API.market" : provider === "apimart" ? "APIMart" : provider === "higgsfield" ? "Higgsfield" : provider === "openai" ? "OpenAI" : provider === "google-ai-studio" ? "Google AI Studio" : provider === "google-vertex" ? "Google Vertex" : provider === "vercel-ai-gateway" ? "Vercel AI Gateway" : "OpenRouter";
    return {
        id: capability.id,
        label: `${providerLabel} · ${capability.label}`,
        provider,
        providerModelId: capability.provider_model_id,
        connectionId: capability.provider_connection_id,
        aspectRatios,
        supportsExpand: provider === "openrouter",
        supportsMask: provider === "openrouter" || provider === "openai",
    };
}

async function getEditorCapabilities(): Promise<ModelCapabilities[]> {
    const providers: EditorProvider[] = [...EDITOR_PROVIDERS];
    const [catalog, ...connections] = await Promise.all([
        getCatalog("image"),
        ...providers.map((provider) => getConnectionForProvider(provider)),
    ]);
    const connectionByProvider = new Map(providers.map((provider, index) => [provider, connections[index] as ProviderConnection | undefined]));
    const openAiConnection = connectionByProvider.get("openai");
    const openAi = openAiConnection?.credentials.apiKey ? openAiCapabilities(openAiConnection) : [];
    const envConnectionId: Partial<Record<EditorProvider, string>> = {
        "google-ai-studio": process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY ? "env:google-ai-studio" : undefined,
        "google-vertex": process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT ? "env:google-vertex" : undefined,
        "vercel-ai-gateway": process.env.AI_GATEWAY_API_KEY ? "env:vercel-ai-gateway" : undefined,
    };
    return [...catalog, ...openAi]
        .map((capability) => {
            if (!capability.provider || !EDITOR_PROVIDERS.includes(capability.provider as EditorProvider)) return undefined;
            if (capability.provider_connection_id) return capability;
            const provider = capability.provider as EditorProvider;
            const connectionId = connectionByProvider.get(provider)?.id ?? envConnectionId[provider];
            return connectionId ? { ...capability, provider_connection_id: connectionId } : undefined;
        })
        .filter((capability): capability is ModelCapabilities => !!capability)
        .filter(isEditorCapability);
}

async function openRouterCatalog(connection: ProviderConnection): Promise<Array<Record<string, unknown>>> {
    const base = (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const response = await providerFetch("openrouter", `${base}/images/models`, {
        headers: { Authorization: `Bearer ${connection.credentials.apiKey}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ImageEditInputError("No se pudo consultar el catálogo de imágenes de OpenRouter.", 503);
    const payload = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(payload?.data)) throw new ImageEditInputError("OpenRouter no devolvió un catálogo válido.", 503);
    return payload.data;
}

function oneText(form: FormData, field: string, maximum: number): string {
    const value = form.get(field);
    if (typeof value !== "string" || value.length > maximum) throw new ImageEditInputError("Revisa las opciones de edición.");
    return value;
}

function optionalFile(form: FormData, field: string): File | null {
    const value = form.get(field);
    if (value === null) return null;
    if (!(value instanceof File)) throw new ImageEditInputError("Adjunta una imagen válida.");
    return value;
}

function readOutpaintPadding(form: FormData): OutpaintPadding {
    try {
        const value: unknown = JSON.parse(oneText(form, "padding", 200));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid padding");
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "bottom,left,right,top") throw new Error("invalid padding");
        if (![row.left, row.right, row.top, row.bottom].every((part) => typeof part === "number")) throw new Error("invalid padding");
        return { left: row.left as number, right: row.right as number, top: row.top as number, bottom: row.bottom as number };
    } catch { throw new ImageEditInputError("Arrastra un borde de la imagen para definir el área que quieres expandir."); }
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const capabilities = await getEditorCapabilities();
        const models = capabilities.map(editorModel);
        const defaultModel = models.find((model) => model.provider === "openrouter") ?? models[0];
        return NextResponse.json({
            configured: models.length > 0,
            models,
            defaultModelId: defaultModel?.id ?? "",
            message: models.length ? "" : "Conecta al menos un proveedor de imágenes en Conexiones de APIs.",
        }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ configured: false, models: [], message: "No se pudo consultar el catálogo de proveedores. Revisa tus conexiones de APIs." }, { headers: { "Cache-Control": "private, no-store" } });
    }
}

export async function POST(req: NextRequest) { return generationEndpoint(req, editImage); }

async function editImage(req: NextRequest) {
    try {
        const form = await req.formData();
        const prompt = oneText(form, "prompt", 3000).trim();
        const model = oneText(form, "model", 80);
        const aspectRatio = oneText(form, "aspectRatio", 20);
        const quality = oneText(form, "quality", 20);
        const operation = oneText(form, "operation", 10);
        const comments = parseImageEditComments(oneText(form, "comments", 5000));
        const expanding = operation === "expand";
        if (!(expanding ? aspectRatio === "auto" : ratios.includes(aspectRatio as typeof ratios[number])) ||
            !qualities.includes(quality as typeof qualities[number]) || !["edit", "erase", "expand"].includes(operation)) throw new ImageEditInputError("Elige opciones de edición válidas.");
        const padding = expanding ? readOutpaintPadding(form) : null;
        if (expanding && !prompt) throw new ImageEditInputError("Escribe qué quieres generar en el área ampliada.");
        const preserveOriginal = expanding && oneText(form, "preserveOriginal", 5) === "true";
        if (expanding && !["true", "false"].includes(oneText(form, "preserveOriginal", 5))) {
            throw new ImageEditInputError("Revisa el modo de expansión.");
        }
        const capabilities = await getEditorCapabilities();
        const capability = capabilities.find((item) => item.id === model);
        if (!capability || !isEditorCapability(capability)) throw new ImageEditInputError("El modelo seleccionado ya no está disponible. Actualiza el catálogo y vuelve a intentarlo.");
        const provider = capability.provider;
        const managedConnection = await getConnectionForProvider(provider, capability.provider_connection_id).catch(() => undefined);
        const connectionRequired = !["google-ai-studio", "google-vertex", "vercel-ai-gateway"].includes(provider);
        if (connectionRequired && !managedConnection?.credentials.apiKey) throw new ImageEditInputError(`La conexión de ${provider} ya no está disponible.`);
        if (expanding && provider !== "openrouter") throw new ImageEditInputError("La expansión de bordes está disponible actualmente con modelos de OpenRouter.");

        const uploaded = optionalFile(form, "sourceFile");
        const sourceTaskId = oneText(form, "sourceTaskId", 100);
        const sourceIndex = oneText(form, "sourceIndex", 2);
        if (!!uploaded === !!sourceTaskId) throw new ImageEditInputError("Selecciona una imagen de la galería o sube una imagen.");
        if (uploaded && uploaded.size > 20 * 1024 * 1024) throw new ImageEditInputError("La imagen supera 20 MB.", 413);
        const taskSource = sourceTaskId ? await taskImageForEdit(sourceTaskId, Number(sourceIndex)) : null;
        const source = await normalizeImageEditInput(taskSource?.image ?? Buffer.from(await uploaded!.arrayBuffer()));
        const maskFile = optionalFile(form, "mask");
        if (expanding && (maskFile || comments.length)) throw new ImageEditInputError("La expansión no admite máscaras ni comentarios. Usa las otras herramientas para esos cambios.");
        const mask = maskFile ? await maskForImageEdit(Buffer.from(await maskFile.arrayBuffer()), source.width, source.height) : null;
        if (operation === "erase" && !mask) throw new ImageEditInputError("Pinta las partes que quieres borrar.");
        if (!prompt && !comments.length && operation !== "erase" && !expanding) throw new ImageEditInputError("Escribe un cambio o añade al menos un comentario sobre la imagen.");
        const referenceFile = optionalFile(form, "reference");
        if (referenceFile && referenceFile.size > 10 * 1024 * 1024) throw new ImageEditInputError("La referencia supera 10 MB.", 413);
        const reference = referenceFile ? await normalizeImageEditInput(Buffer.from(await referenceFile.arrayBuffer())) : null;
        const catalog = provider === "openrouter" ? await openRouterCatalog(managedConnection!) : [];
        const chosen = provider === "openrouter" ? catalog.find((item) => item.id === capability.provider_model_id) : undefined;
        let outpaintPlan = null;
        if (padding) {
            try { outpaintPlan = planOutpaint(source.width, source.height, padding, supportedOpenRouterEditRatios(chosen).filter((ratio) =>
                OUTPAINT_RATIOS.includes(ratio as OutpaintRatio) && supportsOpenRouterEditOptions(chosen, quality, ratio, 2 + Number(!!reference)))); }
            catch (error) { throw new ImageEditInputError(error instanceof Error ? error.message : "No se puede expandir este tamaño.", 400); }
        }
        const effectiveAspectRatio = outpaintPlan?.ratio ?? aspectRatio;
        if (provider === "openrouter" && !supportsOpenRouterEditOptions(chosen, quality, effectiveAspectRatio, 1 + Number(expanding || !!mask || !!comments.length) + Number(!!reference))) {
            throw new ImageEditInputError("El modelo de OpenRouter no admite estas referencias u opciones. Elige otra configuración.");
        }
        if ((mask || operation === "erase") && !["openrouter", "openai"].includes(provider)) {
            throw new ImageEditInputError("Este proveedor admite edición con imagen de referencia, pero no máscaras. Elige OpenAI u OpenRouter para borrar o pintar zonas.");
        }
        const guide = provider === "openrouter"
            ? outpaintPlan ? await makeOutpaintGuide(source.png, outpaintPlan.provider) : mask || comments.length ? await editGuideForOpenRouter(source.png, mask, comments, source.width, source.height) : null
            : null;
        let rootTaskId = taskSource?.rootTaskId ?? "";
        const rootIndex = taskSource?.rootIndex ?? 0;
        if (!rootTaskId) {
            // Persist an uploaded original as a normal local gallery image so comparison
            // and further edits survive a reload. No provider is called for this task.
            rootTaskId = (await persistImageEditSource(source.png)).taskId;
        }
        const modelId = capability.id;
        const editPrompt = expanding && outpaintPlan ? [
            `Expand the first image beyond only its original boundaries. The second image is a spatial guide for the extended canvas: the existing image rectangle stays in place and every transparent area must become coherent new scene content. The user extended the original by ${padding!.left}px left, ${padding!.right}px right, ${padding!.top}px above and ${padding!.bottom}px below. Generate a ${effectiveAspectRatio} provider image; the extra outer margin will be cropped to the user's exact ${outpaintPlan.target.width}x${outpaintPlan.target.height} canvas. Do not leave transparent, white, checkerboard, or placeholder borders. Continue perspective, lighting, background, typography and visual style naturally. Do not crop or stretch the original subject.`,
            prompt || "Extend the scene naturally and keep the original content recognizable.",
            reference ? "The final image is an additional style reference." : "",
        ].filter(Boolean).join("\n\n") : [
            prompt,
            comments.length ? `Apply all numbered comments to the original image in one edit:\n${comments.map((item, index) => `${index + 1}. At marker ${index + 1} (${Math.round(item.x * 100)}% across, ${Math.round(item.y * 100)}% down): ${item.text}`).join("\n")}` : "",
            operation === "erase" ? "Remove the object(s) inside every red painted area and reconstruct the background naturally. Keep all other content unchanged." : "",
            guide ? "The first image is the original. The second is a guide with red painted areas and/or numbered markers. Use it only to locate changes. Do not include paint, markers or numbers in the output. Preserve unrelated parts as closely as possible. Any later image is an additional visual reference." : "Use the supplied image as the original. Preserve unrelated parts as closely as possible.",
        ].filter(Boolean).join("\n\n");
        const asReference = (data: Buffer) => providerImageReference(provider, data, "image/png", capability.provider_model_id);
        const imageMedia = {
            source: await asReference(source.png),
            ...(guide ? { region_guide: await asReference(guide) } : {}),
            ...(reference ? { reference: await asReference(reference.png) } : {}),
            ...(provider === "openai" && mask ? { mask: await asReference(mask) } : {}),
        };
        const openAiSize = { auto: "auto", "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" }[effectiveAspectRatio] ?? "auto";
        const taskId = await submitGeneration({
            companyId: sourceTaskId ? getTask(sourceTaskId)?.company_id : undefined,
            mediaType: "image", modelId, capabilities: capability,
            params: {
                model_id: modelId,
                prompt: editPrompt,
                ...(provider === "openai" ? { size: openAiSize } : { aspect_ratio: effectiveAspectRatio }),
                field_values: { quality, n: 1 },
            },
            media: { images: imageMedia },
            reuseState: {
                edit_root_task_id: rootTaskId,
                edit_root_index: rootIndex,
                edit_parent_task_id: sourceTaskId || rootTaskId,
                edit_parent_index: sourceTaskId ? Number(sourceIndex) : 0,
                edit_mode: expanding ? "expand" : operation === "erase" ? "erase" : mask ? "guided-region" : comments.length ? "comments" : "prompt",
                edit_instruction: prompt || (expanding ? "Expandir bordes" : ""),
                edit_comments: comments,
                edit_has_reference: !!reference,
                ...(outpaintPlan ? { edit_expand_ratio: effectiveAspectRatio, edit_expand_padding: padding, edit_expand_size: { width: outpaintPlan.target.width, height: outpaintPlan.target.height }, edit_expand_preserve_original: preserveOriginal } : {}),
            },
        });
        const task = getTask(taskId);
        if (task?.status !== "COMPLETED") throw new ImageEditInputError("El proveedor seleccionado no devolvió una imagen válida. Revisa el historial y el consumo antes de reintentar.", 502);
        let warning = "";
        if (outpaintPlan) {
            try {
                const generatedPath = task.result_paths?.[0];
                if (!generatedPath) throw new Error("generated image not saved");
                const finished = await finishOutpaint(await fs.readFile(generatedPath), source.png, outpaintPlan, preserveOriginal);
                task.result_paths = [await saveDownload(taskId, "_0-expanded.png", finished)];
                task.reuse_state = { ...task.reuse_state, edit_expand_finalized: true, edit_expand_preserve_applied: preserveOriginal };
                await saveTasks();
            } catch {
                warning = "La expansión se generó, pero no se pudo recortar al tamaño marcado en el lienzo. Revisa esta versión antes de volver a generar: puede haber consumido créditos.";
            }
        }
        return NextResponse.json({ taskId, rootTaskId, rootIndex, imageUrl: `/api/download/${encodeURIComponent(taskId)}?index=0`, modelId: model, warning }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof ImageEditInputError) return NextResponse.json({ error: error.message }, { status: error.status });
        const code = publicErrorMessage(error);
        const messages: Record<string, [number, string]> = {
            ERR_OPENROUTER_CREDITS: [402, "OpenRouter indica que no hay créditos suficientes."],
            ERR_OPENROUTER_TIMEOUT: [504, "La edición tardó demasiado. Revisa el historial y el consumo antes de reintentar."],
            ERR_OPENROUTER_NETWORK: [502, "No se pudo conectar con OpenRouter. Revisa el historial antes de reintentar."],
            ERR_OPENROUTER_INVALID_RESPONSE: [502, "OpenRouter no devolvió una imagen válida. Revisa el consumo antes de reintentar."],
            ERR_OPENAI_LIMIT: [402, "OpenAI rechazó la edición por límite o créditos insuficientes."],
            ERR_OPENAI_TIMEOUT: [504, "La edición con OpenAI tardó demasiado. Revisa el historial antes de reintentar."],
            ERR_OPENAI_NETWORK: [502, "No se pudo conectar con OpenAI. Revisa la conexión y vuelve a intentarlo."],
            ERR_OPENAI_REJECTED_INPUT: [400, "OpenAI rechazó las imágenes o las opciones de edición enviadas."],
        };
        if (messages[code]) return NextResponse.json({ error: messages[code][1] }, { status: messages[code][0] });
        if (code.startsWith("ERR_OPENROUTER_") || code.startsWith("ERR_OPENAI_") || code.startsWith("ERR_HIGGSFIELD_") || code.startsWith("ERR_API_MARKET_") || code.startsWith("ERR_APIMART_") || code === "ERR_NO_IMAGE_GENERATED") return NextResponse.json({ error: `El proveedor seleccionado no pudo editar la imagen (${code}). Revisa la conexión y el consumo antes de reintentar.` }, { status: 502 });
        return securityError(error);
    }
}
