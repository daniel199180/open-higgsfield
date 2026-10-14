import fs from "node:fs/promises";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, readJsonBody, securityError } from "@/lib/api-security";
import { backgroundRemovalModels } from "@/lib/background-removal-models";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { submitGeneration } from "@/lib/generation-service";
import { generationEndpoint } from "@/lib/generation-request";
import { getTask, initStore } from "@/lib/task-store";
import { publicErrorMessage } from "@/lib/public-error";
import { findCapability } from "@/providers/catalog";
import { providerFetch } from "@/providers/secure-fetch";
import { readAsset } from "@/workflows/assets";
import { WorkflowError } from "@/workflows/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const sourceSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("asset"), assetId: z.uuid() }).strict(),
    z.object({ type: z.literal("task"), taskId: z.string().min(1).max(100), index: z.number().int().min(0).max(9) }).strict(),
]);
const requestSchema = z.object({ source: sourceSchema, modelId: z.string().max(150).optional() }).strict();

function catalogUrl(connection: ProviderConnection): string {
    return `${(connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/images/models`;
}

async function availableModels(connection: ProviderConnection) {
    const response = await providerFetch("openrouter", catalogUrl(connection), {
        headers: { Authorization: `Bearer ${connection.credentials.apiKey}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new WorkflowError("No se pudo consultar los modelos de OpenRouter.", 502);
    const payload = await response.json() as { data?: unknown };
    return backgroundRemovalModels(payload.data);
}

async function sourceImage(source: z.infer<typeof sourceSchema>): Promise<Buffer> {
    let data: Buffer;
    if (source.type === "asset") {
        const asset = await readAsset(source.assetId);
        if (asset.asset.kind !== "image") throw new WorkflowError("Selecciona una imagen raster válida.", 400);
        data = asset.data;
    } else {
        await initStore();
        const task = getTask(source.taskId);
        if (!task || task.media_type !== "image" || task.status !== "COMPLETED") throw new WorkflowError("La imagen original ya no está disponible.", 404);
        const file = task.result_paths?.[source.index];
        if (file) {
            data = await fs.readFile(file).catch(() => { throw new WorkflowError("No se encontró la imagen original.", 404); });
        } else {
            const url = task.result_urls?.[source.index] ?? "";
            const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
            if (!match || match[1].length > 28 * 1024 * 1024) throw new WorkflowError("No se encontró la imagen original.", 404);
            data = Buffer.from(match[1], "base64");
        }
    }
    if (!data.length || data.length > 20 * 1024 * 1024) throw new WorkflowError("La imagen debe pesar menos de 20 MB.", 413);
    try {
        const image = sharp(data, { limitInputPixels: 40_000_000 });
        const meta = await image.metadata();
        if (!["png", "jpeg", "webp", "avif"].includes(meta.format ?? "")) throw new Error("invalid image");
        const png = await image.rotate().png().toBuffer();
        if (png.length > 20 * 1024 * 1024) throw new WorkflowError("La imagen procesada supera 20 MB.", 413);
        return png;
    } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError("La imagen original no tiene un formato válido.", 400);
    }
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const connection = await getConnectionForProvider("openrouter");
        if (!connection?.credentials.apiKey) return NextResponse.json({ models: [], message: "Conecta OpenRouter para quitar fondos con GPT Image." }, { headers: { "Cache-Control": "no-store" } });
        const models = await availableModels(connection);
        return NextResponse.json({ models, defaultModelId: models[0]?.id ?? "", message: models.length ? "" : "OpenRouter no anuncia un GPT Image con referencias y fondo transparente en esta conexión." }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ models: [], message: error instanceof WorkflowError ? error.message : "No se pudo consultar OpenRouter." }, { headers: { "Cache-Control": "no-store" } });
    }
}

export async function POST(req: NextRequest) {
    return generationEndpoint(req, removeBackground);
}

async function removeBackground(req: NextRequest) {
    try {
        const input = requestSchema.parse(await readJsonBody(req));
        const connection = await getConnectionForProvider("openrouter");
        if (!connection?.credentials.apiKey) throw new WorkflowError("Conecta OpenRouter en Conexiones de APIs.", 400);
        const models = await availableModels(connection);
        const chosen = models.find(item => item.id === (input.modelId || models[0]?.id));
        if (!chosen) throw new WorkflowError("Elige un GPT Image de OpenRouter que admita referencias y transparencia.", 400);
        const modelId = `openrouter:image:${encodeURIComponent(connection.id)}:${encodeURIComponent(chosen.id)}`;
        const capability = await findCapability("image", modelId);
        if (!capability || capability.provider !== "openrouter" || capability.provider_model_id !== chosen.id) throw new WorkflowError("El modelo elegido ya no está disponible en OpenRouter.", 503);
        const original = await sourceImage(input.source);
        const sourceTask = input.source.type === "task" ? getTask(input.source.taskId) : null;
        const rootTaskId = sourceTask && typeof sourceTask.reuse_state?.edit_root_task_id === "string" ? sourceTask.reuse_state.edit_root_task_id : input.source.type === "task" ? input.source.taskId : "";
        const rootIndex = sourceTask && typeof sourceTask.reuse_state?.edit_root_index === "number" ? sourceTask.reuse_state.edit_root_index : input.source.type === "task" ? input.source.index : 0;
        const prompt = "Extract the main subject from the supplied image and remove only the background. Output a real transparent background with a clean alpha channel, not a drawn checkerboard. Preserve the subject, logo, all lettering, colors, proportions and fine details as closely as possible. Do not redraw, restyle, add objects, add a shadow, or crop the subject.";
        const taskId = await submitGeneration({
            companyId: sourceTask?.company_id,
            mediaType: "image", modelId, capabilities: capability,
            params: { model_id: modelId, prompt, field_values: { background: "transparent", output_format: "png", quality: "high", n: 1 } },
            media: { images: { input_references: `data:image/png;base64,${original.toString("base64")}` } },
            ...(rootTaskId ? { reuseState: { edit_root_task_id: rootTaskId, edit_root_index: rootIndex, edit_parent_task_id: input.source.type === "task" ? input.source.taskId : rootTaskId, edit_parent_index: input.source.type === "task" ? input.source.index : 0, edit_mode: "remove-background", edit_instruction: "Quitar fondo" } } : {}),
        });
        const task = getTask(taskId);
        if (task?.status !== "COMPLETED") throw new WorkflowError("OpenRouter no devolvió una imagen transparente válida. Revisa el consumo antes de reintentar.", 502);
        return NextResponse.json({ taskId, imageUrl: `/api/download/${taskId}?index=0`, modelId: chosen.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        if (error instanceof WorkflowError) return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof z.ZodError) return NextResponse.json({ error: "Revisa la imagen y el modelo elegidos." }, { status: 400 });
        const code = publicErrorMessage(error);
        if (code === "ERR_OPENROUTER_IMAGE_NOT_TRANSPARENT") return NextResponse.json({ error: "El modelo devolvió una imagen sin transparencia real. Revisa el consumo antes de reintentar." }, { status: 502 });
        if (code === "ERR_OPENROUTER_CREDITS") return NextResponse.json({ error: "OpenRouter indica que no hay créditos suficientes." }, { status: 402 });
        if (code.startsWith("ERR_OPENROUTER_")) return NextResponse.json({ error: `OpenRouter no pudo quitar el fondo (${code}). Revisa el consumo antes de reintentar.` }, { status: 502 });
        return securityError(error);
    }
}
