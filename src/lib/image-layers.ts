import "server-only";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { downloadPublicMedia } from "@/lib/media-download";
import { saveDownload } from "@/lib/upload";
import { getTask, initStore, saveTasks, setTask } from "@/lib/task-store";
import { shortId } from "@/lib/payload-utils";
import type { ImageLayerMetadata, ImageLayerSet, ImageTask, TaskEvent } from "@/types";
import { providerFetch } from "@/providers/secure-fetch";
import { isLayerTask } from "@/lib/image-layer-task";

const MODEL = "seedream-5-0-pro";
const MAX_POLL_MS = 240_000;

export class ImageLayerError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

type JsonRecord = Record<string, unknown>;

function records(value: unknown): JsonRecord[] {
    if (Array.isArray(value)) return value.filter((item): item is JsonRecord => !!item && typeof item === "object" && !Array.isArray(item));
    return value && typeof value === "object" && !Array.isArray(value) ? [value as JsonRecord] : [];
}

function taskId(payload: JsonRecord): string | undefined {
    for (const item of records(payload.data)) {
        const id = item.task_id ?? item.id;
        if (typeof id === "string" && id) return id;
    }
    const id = payload.task_id ?? payload.id;
    return typeof id === "string" && id ? id : undefined;
}

function taskBody(payload: JsonRecord): JsonRecord {
    const data = payload.data;
    return data && typeof data === "object" && !Array.isArray(data) ? data as JsonRecord : payload;
}

async function requestJson(url: string, connection: ProviderConnection, init: RequestInit = {}): Promise<JsonRecord> {
    let response: Response;
    try {
        response = await providerFetch("apimart", url, {
            ...init,
            headers: { Authorization: `Bearer ${connection.credentials.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
        });
    } catch (error) {
        if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new ImageLayerError("APIMart tardó demasiado en responder.", 504);
        throw new ImageLayerError("No se pudo conectar con APIMart.", 502);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload) || "error" in payload) {
        if (response.status === 401) throw new ImageLayerError("APIMart rechazó la clave. Revisa la conexión de APIMart.", 401);
        throw new ImageLayerError("APIMart rechazó la descomposición en capas.", 502);
    }
    return payload as JsonRecord;
}

function urlFromValue(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/[^\s]+$/i.test(value)) return value;
    return undefined;
}

function outputUrls(value: unknown, result: string[] = []): string[] {
    const direct = urlFromValue(value);
    if (direct) { result.push(direct); return result; }
    if (!value || typeof value !== "object") return result;
    if (Array.isArray(value)) { for (const item of value) outputUrls(item, result); return result; }
    const record = value as JsonRecord;
    for (const key of ["url", "image_url", "output_url", "download_url", "images", "outputs", "urls"]) {
        if (key in record) outputUrls(record[key], result);
    }
    return [...new Set(result)];
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tuple(value: unknown, fallback: [number, number, number, number]): [number, number, number, number] {
    if (Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every((part) => typeof part === "number" && Number.isFinite(part))) return value.slice(0, 4) as [number, number, number, number];
    if (value && typeof value === "object") {
        const row = value as JsonRecord;
        const candidate = [row.x1 ?? row.left, row.y1 ?? row.top, row.x2 ?? (typeof row.width === "number" && typeof row.x1 === "number" ? row.x1 + row.width : undefined), row.y2 ?? (typeof row.height === "number" && typeof row.y1 === "number" ? row.y1 + row.height : undefined)];
        if (candidate.every((part) => typeof part === "number" && Number.isFinite(part))) return candidate as [number, number, number, number];
    }
    return fallback;
}

function parseSize(value: unknown, fallback: { width: number; height: number }) {
    if (Array.isArray(value)) return { width: numberOr(value[0], fallback.width), height: numberOr(value[1], fallback.height) };
    if (value && typeof value === "object") {
        const row = value as JsonRecord;
        return { width: numberOr(row.width, fallback.width), height: numberOr(row.height, fallback.height) };
    }
    return fallback;
}

export function parseLayerDecomposition(payload: JsonRecord, sourceWidth: number, sourceHeight: number): { urls: string[]; layers: ImageLayerMetadata[] } | null {
    const body = taskBody(payload);
    const result = body.result ?? body.output ?? body.data ?? body;
    const urls = outputUrls(result);
    const rawLayers = (result && typeof result === "object" && !Array.isArray(result) ? (result as JsonRecord).layers : undefined) ?? body.layers;
    const layerRows = Array.isArray(rawLayers) ? rawLayers : [];
    if (!urls.length) return null;
    const layers: ImageLayerMetadata[] = urls.map((_, index) => {
        const raw = (layerRows[index] && typeof layerRows[index] === "object" ? layerRows[index] as JsonRecord : {}) as JsonRecord;
        const normalized = tuple(raw.bounding_box_normalized ?? (raw.bounding_box && typeof raw.bounding_box === "object" ? (raw.bounding_box as JsonRecord).normalized : undefined), [0, 0, 1000, 1000]);
        const absolute = tuple(raw.bounding_box_absolute ?? (raw.bounding_box && typeof raw.bounding_box === "object" ? (raw.bounding_box as JsonRecord).absolute : undefined), index === 0 ? [0, 0, sourceWidth, sourceHeight] : [0, 0, sourceWidth, sourceHeight]);
        return {
            index,
            zIndex: Math.round(numberOr(raw.z_index, index)),
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : index === 0 ? "Imagen base" : `Capa ${index}`,
            description: typeof raw.description === "string" ? raw.description.trim().slice(0, 400) : "",
            size: parseSize(raw.size, { width: Math.max(1, absolute[2] - absolute[0]), height: Math.max(1, absolute[3] - absolute[1]) }),
            boundingBox: { absolute, normalized },
        };
    });
    return { urls, layers };
}

async function sourceData(taskIdValue: string, index: number): Promise<{ task: ImageTask; png: Buffer; width: number; height: number }> {
    await initStore();
    const task = getTask(taskIdValue);
    if (!task || task.media_type !== "image" || task.status !== "COMPLETED") throw new ImageLayerError("La imagen original ya no está disponible.", 404);
    const file = task.result_paths?.[index];
    let data: Buffer;
    if (file) data = await fs.readFile(file).catch(() => { throw new ImageLayerError("No se encontró la imagen original.", 404); });
    else {
        const value = task.result_urls?.[index] ?? "";
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
        if (!match) throw new ImageLayerError("No se encontró la imagen original.", 404);
        data = Buffer.from(match[1], "base64");
    }
    try {
        const image = sharp(data, { limitInputPixels: 40_000_000, failOn: "error" }).rotate().png();
        const png = await image.toBuffer();
        const meta = await sharp(png).metadata();
        if (!meta.width || !meta.height) throw new Error("invalid dimensions");
        return { task: task as ImageTask, png, width: meta.width, height: meta.height };
    } catch { throw new ImageLayerError("La imagen original no tiene un formato válido."); }
}

async function imageBuffer(url: string): Promise<Buffer> {
    if (url.startsWith("data:")) {
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
        if (!match) throw new ImageLayerError("APIMart devolvió una capa inválida.", 502);
        return Buffer.from(match[1], "base64");
    }
    try { return Buffer.from((await downloadPublicMedia(url)).data); }
    catch { throw new ImageLayerError("No se pudo guardar una de las capas devueltas por APIMart.", 502); }
}

async function poll(connection: ProviderConnection, providerTaskId: string, sourceWidth: number, sourceHeight: number): Promise<{ urls: string[]; layers: ImageLayerMetadata[] }> {
    const started = Date.now();
    for (;;) {
        const payload = await requestJson(`/v1/tasks/${encodeURIComponent(providerTaskId)}?language=es`, connection);
        const body = taskBody(payload);
        const status = String(body.status ?? "").toLowerCase();
        if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new ImageLayerError("APIMart no pudo separar la imagen en capas.", 502);
        const parsed = parseLayerDecomposition(payload, sourceWidth, sourceHeight);
        if (["completed", "success", "succeeded", "done"].includes(status)) {
            if (parsed) return parsed;
            throw new ImageLayerError("APIMart terminó la tarea sin devolver capas válidas.", 502);
        }
        if (parsed && !["pending", "processing", "submitted", "queued", "in_progress"].includes(status)) return parsed;
        if (Date.now() - started > MAX_POLL_MS) throw new ImageLayerError("APIMart tardó demasiado en separar la imagen. Revisa el historial antes de reintentar.", 504);
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
}

function layerSet(sourceWidth: number, sourceHeight: number, parsed: { layers: ImageLayerMetadata[] }): ImageLayerSet {
    return { version: 1, model: MODEL, sourceWidth, sourceHeight, baseIndex: 0, layers: parsed.layers };
}

async function persistLayerTask(args: { sourceTask?: ImageTask; parentTaskId: string; parentIndex: number; prompt: string; connectionId: string; layerSet: ImageLayerSet; buffers: Buffer[]; mode: "layer-decomposition" | "layer-edit" }): Promise<{ task: ImageTask; imageUrl: string }> {
    const taskIdValue = shortId();
    const paths: string[] = [];
    for (const [index, buffer] of args.buffers.entries()) paths.push(await saveDownload(taskIdValue, `_${index}-layer.png`, buffer));
    const root = typeof args.sourceTask?.reuse_state?.edit_root_task_id === "string" ? args.sourceTask.reuse_state.edit_root_task_id : args.sourceTask?.task_id ?? args.parentTaskId;
    const rootIndex = typeof args.sourceTask?.reuse_state?.edit_root_index === "number" ? args.sourceTask.reuse_state.edit_root_index : args.parentIndex;
    const sourceTaskId = typeof args.sourceTask?.reuse_state?.layer_source_task_id === "string"
        ? args.sourceTask.reuse_state.layer_source_task_id
        : isLayerTask(args.sourceTask) ? args.sourceTask?.reuse_state?.layer_source_task_id : args.sourceTask?.task_id ?? args.parentTaskId;
    const sourceIndex = typeof args.sourceTask?.reuse_state?.layer_source_index === "number"
        ? args.sourceTask.reuse_state.layer_source_index
        : typeof args.sourceTask?.reuse_state?.edit_parent_index === "number" && isLayerTask(args.sourceTask) ? args.sourceTask.reuse_state.edit_parent_index : args.parentIndex;
    const events: TaskEvent[] = [{ type: "completed", media_type: "image", result_urls: paths.map((_, index) => `/api/download/${taskIdValue}?index=${index}`), result_count: paths.length, has_download: true }];
    const task = {
        task_id: taskIdValue, company_id: args.sourceTask?.company_id, status: "COMPLETED", freepik_status: "COMPLETED", provider_id: "apimart" as const, internal_kind: "layer" as const,
        provider_model_id: MODEL, provider_connection_id: args.connectionId, prompt: args.prompt || "Separar imagen en capas", model_id: `apimart:image:${MODEL}`,
        created_at: new Date().toISOString(), media_type: "image" as const, result_paths: paths, result_urls: paths.map((_, index) => `/api/download/${taskIdValue}?index=${index}`),
        reuse_state: { edit_root_task_id: root, edit_root_index: rootIndex, edit_parent_task_id: args.parentTaskId, edit_parent_index: args.parentIndex, edit_mode: args.mode, edit_instruction: args.prompt, layer_source_task_id: sourceTaskId, layer_source_index: sourceIndex, layer_set: args.layerSet },
        events, _done: true,
    } as ImageTask & { events: TaskEvent[]; _done: boolean };
    setTask(task); await saveTasks();
    return { task, imageUrl: `/api/download/${taskIdValue}?index=0` };
}

export async function decomposeImage(taskIdValue: string, index: number, prompt: string, size: string): Promise<{ taskId: string; imageUrl: string; layers: ImageLayerMetadata[] }> {
    const source = await sourceData(taskIdValue, index);
    const connection = await getConnectionForProvider("apimart");
    if (!connection?.credentials.apiKey) throw new ImageLayerError("Conecta APIMart antes de separar imágenes en capas.", 400);
    const payload = await requestJson("/v1/images/generations", connection, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: prompt || undefined, image_urls: [`data:image/png;base64,${source.png.toString("base64")}`], layer_decomposition: true, size: ["auto", "1K", "1.5K", "2K"].includes(size) ? size : "auto", output_format: "png" }) });
    const providerTaskId = taskId(payload);
    let parsed = providerTaskId ? await poll(connection, providerTaskId, source.width, source.height) : parseLayerDecomposition(payload, source.width, source.height);
    if (!parsed) throw new ImageLayerError("APIMart no devolvió capas válidas.", 502);
    parsed = { ...parsed, layers: parseLayerDecomposition({ result: { url: parsed.urls, layers: parsed.layers } }, source.width, source.height)!.layers };
    const buffers = await Promise.all(parsed.urls.map(imageBuffer));
    const saved = await persistLayerTask({ sourceTask: source.task, parentTaskId: taskIdValue, parentIndex: index, prompt, connectionId: connection.id, layerSet: layerSet(source.width, source.height, parsed), buffers, mode: "layer-decomposition" });
    return { taskId: saved.task.task_id, imageUrl: saved.imageUrl, layers: (saved.task.reuse_state?.layer_set as ImageLayerSet).layers };
}

export async function editImageLayer(layerTaskId: string, layerIndex: number, prompt: string): Promise<{ taskId: string; imageUrl: string; layers: ImageLayerMetadata[] }> {
    await initStore();
    const parent = getTask(layerTaskId);
    const layerSet = parent?.reuse_state?.layer_set as ImageLayerSet | undefined;
    if (!parent || parent.media_type !== "image" || parent.status !== "COMPLETED" || !layerSet || !Number.isInteger(layerIndex) || layerIndex <= 0 || layerIndex >= layerSet.layers.length) throw new ImageLayerError("Selecciona una capa editable válida.");
    if (!prompt.trim() || prompt.length > 3000) throw new ImageLayerError("Describe el cambio de la capa.");
    const connection = await getConnectionForProvider("apimart");
    if (!connection?.credentials.apiKey) throw new ImageLayerError("Conecta APIMart antes de editar una capa.", 400);
    const layerPath = parent.result_paths?.[layerIndex];
    if (!layerPath) throw new ImageLayerError("No se encontró el archivo de la capa.", 404);
    const layer = await fs.readFile(layerPath);
    const payload = await requestJson("/v1/images/generations", connection, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: `${prompt.trim()} Preserve transparency and keep the layer composition aligned to its original canvas.`, image_urls: [`data:image/png;base64,${layer.toString("base64")}`], background: "transparent", output_format: "png", size: "auto" }) });
    const providerTaskId = taskId(payload);
    const parsed = providerTaskId ? await poll(connection, providerTaskId, layerSet.sourceWidth, layerSet.sourceHeight) : parseLayerDecomposition(payload, layerSet.sourceWidth, layerSet.sourceHeight);
    if (!parsed?.urls[0]) throw new ImageLayerError("APIMart no devolvió la capa editada.", 502);
    const edited = await imageBuffer(parsed.urls[0]);
    const buffers = await Promise.all((parent.result_paths ?? []).map((file, index) => index === layerIndex ? edited : fs.readFile(file)));
    const nextSet: ImageLayerSet = { ...layerSet, layers: layerSet.layers.map((item) => item.index === layerIndex ? { ...item, description: prompt.trim().slice(0, 400) } : item) };
    const saved = await persistLayerTask({ sourceTask: parent as ImageTask, parentTaskId: layerTaskId, parentIndex: 0, prompt, connectionId: connection.id, layerSet: nextSet, buffers, mode: "layer-edit" });
    return { taskId: saved.task.task_id, imageUrl: saved.imageUrl, layers: nextSet.layers };
}
