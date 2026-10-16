import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { downloadPublicMedia } from "@/lib/media-download";
import { saveDownload } from "@/lib/upload";
import { getTask, getStore, initStore, saveTasks, setTask } from "@/lib/task-store";
import { shortId } from "@/lib/payload-utils";
import type { ImageLayerMetadata, ImageLayerSet, ImageTask, TaskEvent } from "@/types";
import { providerFetch } from "@/providers/secure-fetch";
import { isLayerTask } from "@/lib/image-layer-task";
import { STORAGE_ROOT } from "@/lib/storage-paths";

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

type OutputEntry = { url: string; record?: JsonRecord };

function outputEntry(value: unknown): OutputEntry | undefined {
    const direct = urlFromValue(value);
    if (direct) return { url: direct };
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as JsonRecord;
    for (const key of ["url", "image_url", "output_url", "download_url", "b64_json"]) {
        const url = key === "b64_json" && typeof record[key] === "string"
            ? (record[key] as string).startsWith("data:image/") ? record[key] as string : `data:image/png;base64,${record[key] as string}`
            : urlFromValue(record[key]);
        if (url) return { url, record };
    }
    return undefined;
}

/**
 * Keep provider image data positional. Seedream's z_index and bounding_box
 * belong to the corresponding data item, so recursively flattening every URL
 * can silently pair a layer with another layer's metadata.
 */
function outputEntries(value: unknown): OutputEntry[] {
    const direct = outputEntry(value);
    if (direct) return [direct];
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap((item) => outputEntries(item));
    const record = value as JsonRecord;
    // APIMart keeps metadata beside the URL array, inside result.images[].
    // Zip here, before descending into URL strings and losing their parent.
    if (Array.isArray(record.url) && (record.layer_decomposition === true || Array.isArray(record.layers))) {
        const layers = record.layers;
        if (!Array.isArray(layers) || layers.length !== record.url.length || !layers.length || layers.length > 17) {
            throw new ImageLayerError("APIMart devolvió capas sin sus posiciones completas. No se guardó una composición desalineada.", 502);
        }
        for (const key of ["sizes", "output_formats"]) {
            if (record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length !== layers.length)) {
                throw new ImageLayerError("APIMart devolvió metadatos de capas inconsistentes.", 502);
            }
        }
        return record.url.map((value, index) => {
            const url = urlFromValue(value);
            const layer = layers[index];
            if (!url || !layer || typeof layer !== "object" || Array.isArray(layer)) throw new ImageLayerError("APIMart devolvió una capa inválida.", 502);
            const row = layer as JsonRecord;
            if (typeof row.z_index !== "number" || !Number.isInteger(row.z_index) || row.z_index < 0) throw new ImageLayerError("APIMart devolvió una capa sin orden de apilamiento válido.", 502);
            return { url, record: { ...row, size: row.size ?? (record.sizes as unknown[] | undefined)?.[index], role: index === 0 ? "base" : "layer" } };
        });
    }
    for (const key of ["data", "images", "outputs", "urls", "url"]) {
        if (!(key in record)) continue;
        const entries = outputEntries(record[key]);
        if (entries.length) return entries;
    }
    return [];
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

function optionalTuple(value: unknown): [number, number, number, number] | undefined {
    const result = tuple(value, [Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
    return result.every(Number.isFinite) ? result : undefined;
}

function normalizedToAbsolute(normalized: [number, number, number, number], canvasWidth: number, canvasHeight: number): [number, number, number, number] {
    const scale = 1000;
    const [left, top, right, bottom] = normalized;
    return [left / scale * canvasWidth, top / scale * canvasHeight, right / scale * canvasWidth, bottom / scale * canvasHeight];
}

function normalizedBox(value: unknown): [number, number, number, number] | undefined {
    const candidate = optionalTuple(value);
    if (!candidate || candidate[2] <= candidate[0] || candidate[3] <= candidate[1]) return undefined;
    return candidate;
}

function layerBounds(raw: JsonRecord, canvasSize: { width: number; height: number }, isBase: boolean): { absolute: [number, number, number, number]; normalized: [number, number, number, number]; source: NonNullable<ImageLayerMetadata["boundingBoxSource"]> } {
    const box = raw.bounding_box && typeof raw.bounding_box === "object" ? raw.bounding_box as JsonRecord : undefined;
    const absolute = normalizedBox(raw.bounding_box_absolute ?? box?.absolute);
    if (absolute) return { absolute, normalized: absolute.map((part, index) => part / (index % 2 === 0 ? canvasSize.width : canvasSize.height) * 1000) as [number, number, number, number], source: "absolute" };
    const normalized = normalizedBox(raw.bounding_box_normalized ?? box?.normalized);
    if (normalized) return { absolute: normalizedToAbsolute(normalized, canvasSize.width, canvasSize.height), normalized, source: "normalized" };
    if (isBase) return { absolute: [0, 0, canvasSize.width, canvasSize.height], normalized: [0, 0, 1000, 1000], source: "fallback" };
    const size = parseSize(raw.size, { width: 0, height: 0 });
    if (size.width > 0 && size.height > 0) return { absolute: [0, 0, size.width, size.height], normalized: [0, 0, size.width / canvasSize.width * 1000, size.height / canvasSize.height * 1000], source: "size" };
    return { absolute: [0, 0, canvasSize.width, canvasSize.height], normalized: [0, 0, 1000, 1000], source: "fallback" };
}

function isBaseRecord(record: JsonRecord): boolean {
    const role = String(record.role ?? record.type ?? "").toLowerCase();
    if (role === "layer") return false;
    const name = String(record.name ?? "").toLowerCase();
    return record.is_base === true || role === "base" || role === "background" || /(^|\s)(base|background|fondo)(\s|$)/.test(name);
}

function parseSize(value: unknown, fallback: { width: number; height: number }) {
    if (typeof value === "string") {
        const match = /^(\d+)x(\d+)$/.exec(value.trim());
        if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
    if (Array.isArray(value)) return { width: numberOr(value[0], fallback.width), height: numberOr(value[1], fallback.height) };
    if (value && typeof value === "object") {
        const row = value as JsonRecord;
        return { width: numberOr(row.width, fallback.width), height: numberOr(row.height, fallback.height) };
    }
    return fallback;
}

export function parseLayerDecomposition(payload: JsonRecord, sourceWidth: number, sourceHeight: number): { urls: string[]; layers: ImageLayerMetadata[]; canvasSize: { width: number; height: number }; baseProviderIndex: number } | null {
    const body = taskBody(payload);
    const result = body.result ?? body.output ?? body.data ?? body;
    const entries = outputEntries(result);
    const urls = entries.map((entry) => entry.url);
    const rawLayers = (result && typeof result === "object" && !Array.isArray(result) ? (result as JsonRecord).layers : undefined) ?? body.layers;
    const layerRows = Array.isArray(rawLayers) ? rawLayers : [];
    const metadataRows = layerRows.length ? layerRows : entries.map((entry) => entry.record ?? {});
    if (!urls.length) return null;
    const baseProviderIndex = metadataRows.findIndex((row) => !!row && typeof row === "object" && !Array.isArray(row) && isBaseRecord(row as JsonRecord));
    const resolvedBaseIndex = baseProviderIndex >= 0 ? baseProviderIndex : 0;
    const baseRecord = entries[resolvedBaseIndex]?.record ?? (metadataRows[resolvedBaseIndex] && typeof metadataRows[resolvedBaseIndex] === "object" ? metadataRows[resolvedBaseIndex] as JsonRecord : {});
    const canvasSize = parseSize(baseRecord.size, { width: sourceWidth, height: sourceHeight });
    const layers: ImageLayerMetadata[] = urls.map((_, index) => {
        const raw = (metadataRows[index] && typeof metadataRows[index] === "object" ? metadataRows[index] as JsonRecord : entries[index]?.record ?? {}) as JsonRecord;
        const bounds = layerBounds(raw, canvasSize, index === resolvedBaseIndex);
        return {
            index,
            zIndex: Math.round(numberOr(raw.z_index, index)),
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : index === 0 ? "Imagen base" : `Capa ${index}`,
            description: typeof raw.description === "string" ? raw.description.trim().slice(0, 400) : "",
            size: parseSize(raw.size, { width: Math.max(1, bounds.absolute[2] - bounds.absolute[0]), height: Math.max(1, bounds.absolute[3] - bounds.absolute[1]) }),
            role: index === resolvedBaseIndex ? "base" : "layer",
            boundingBoxSource: bounds.source,
            boundingBox: { absolute: bounds.absolute, normalized: bounds.normalized },
        };
    });
    return { urls, layers, canvasSize, baseProviderIndex: resolvedBaseIndex };
}

/** A cropped PNG cannot tell us where it used to be on the original canvas. */
export function validateLayerPositions(layers: ImageLayerMetadata[], width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 40_000_000) throw new ImageLayerError("El tamaño del lienzo de capas no es válido.", 502);
    for (const layer of layers) {
        if (layer.role === "reference" || layer.role === "base") continue;
        const [left, top, right, bottom] = layer.boundingBox.absolute;
        if (!["absolute", "normalized", "alpha"].includes(layer.boundingBoxSource ?? "") ||
            ![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 || right <= left || bottom <= top || right > width + 1 || bottom > height + 1) {
            throw new ImageLayerError("Faltan posiciones válidas de las capas. Conservamos la imagen original; vuelve a separarla para obtener sus coordenadas.", 422);
        }
    }
}

// Keep the provider response on the server so a parser repair can recover a
// paid result without submitting another generation. Never send it to the UI.
async function saveLayerJob(providerTaskId: string, data: JsonRecord): Promise<void> {
    const directory = path.join(STORAGE_ROOT, "layer-jobs");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(providerTaskId).digest("hex");
    await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify({ providerTaskId, ...data }), { mode: 0o600 });
}

async function assertLayerDiskSpace(bytes = 512 * 1024 * 1024) {
    const disk = await fs.statfs(STORAGE_ROOT);
    if (disk.bavail * disk.bsize < bytes) throw new ImageLayerError("No hay suficiente espacio en disco para guardar las capas. Libera espacio; no vuelvas a generar la imagen.", 507);
}

/** Download only media GETs again, never submit another paid generation. */
export async function downloadLayerAssets(urls: string[], providerTaskId?: string, download = imageBuffer): Promise<Buffer[]> {
    const directory = providerTaskId ? path.join(STORAGE_ROOT, "layer-jobs", `${createHash("sha256").update(providerTaskId).digest("hex")}.assets`) : undefined;
    if (directory) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const buffers: Buffer[] = new Array(urls.length);
    let cursor = 0;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(2, urls.length) }, async () => {
        while (!failure && cursor < urls.length) {
            const index = cursor++;
            const file = directory ? path.join(directory, `${index}.bin`) : undefined;
            try {
                const cached = file ? await fs.readFile(file).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; }) : undefined;
                if (cached) { await sharp(cached, { limitInputPixels: 40_000_000 }).metadata(); buffers[index] = cached; continue; }
                for (let attempt = 0; ; attempt++) {
                    try { buffers[index] = await download(urls[index]); break; }
                    catch (error) {
                        const code = error instanceof Error ? error.message : "";
                        if (attempt >= 2 || !/^ERR_MEDIA_(DOWNLOAD_FAILED|HOST_UNREACHABLE|HTTP_(408|429|5\d\d))$/.test(code)) throw error;
                        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
                    }
                }
                if (file) {
                    await assertLayerDiskSpace(buffers[index].length + 64 * 1024 * 1024);
                    await fs.writeFile(`${file}.tmp`, buffers[index], { mode: 0o600 });
                    await fs.rename(`${file}.tmp`, file);
                }
            } catch (error) {
                failure = error instanceof ImageLayerError ? error : new ImageLayerError(
                    (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? "El disco se llenó al guardar las capas. Libera espacio y recupera el resultado, sin generar de nuevo." : `No se pudo descargar la capa ${index + 1}. Las capas ya descargadas se conservan; usa Recuperar capas sin regenerar.`,
                    (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 502);
            }
        }
    }));
    if (failure) throw failure;
    return buffers;
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
    const media = await downloadPublicMedia(url);
    if (!media.mimeType.startsWith("image/")) throw new ImageLayerError("APIMart devolvió una capa que no es una imagen.", 502);
    return Buffer.from(media.data);
}

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
}

async function alphaBounds(buffer: Buffer): Promise<[number, number, number, number] | undefined> {
    const { data, info } = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width; let top = info.height; let right = -1; let bottom = -1;
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * info.channels + info.channels - 1] <= 2) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    return right > left && bottom > top ? [left, top, right, bottom] : undefined;
}

/**
 * APIMart may return either a full-canvas transparent PNG or a cropped layer.
 * Keep the base at canvas size and normalize each editable layer to its own
 * bounding-box dimensions. The editor then places that crop on the shared
 * provider canvas instead of stretching every output over the whole image.
 */
export async function fitLayerToBounds(buffer: Buffer, layer: ImageLayerMetadata, canvasWidth: number, canvasHeight: number, allowResize = false): Promise<{ buffer: Buffer; boundingBox: ImageLayerMetadata["boundingBox"]; boundingBoxSource: NonNullable<ImageLayerMetadata["boundingBoxSource"]> }> {
    const metadata = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
    const width = metadata.width ?? canvasWidth;
    const height = metadata.height ?? canvasHeight;
    let [rawLeft, rawTop, rawRight, rawBottom] = layer.boundingBox.absolute;
    let source = layer.boundingBoxSource ?? "fallback";
    if (layer.role !== "base" && layer.index !== 0 && (source === "fallback" || source === "size")) {
        if (width === canvasWidth && height === canvasHeight) {
            const detected = await alphaBounds(buffer);
            if (detected) { [rawLeft, rawTop, rawRight, rawBottom] = detected; source = "alpha"; }
        } else {
            throw new ImageLayerError("La capa recortada no incluye su posición original. No se puede alinear automáticamente.", 422);
        }
    }
    const left = clampInt(rawLeft, 0, Math.max(0, canvasWidth - 1));
    const top = clampInt(rawTop, 0, Math.max(0, canvasHeight - 1));
    const right = clampInt(rawRight, left + 1, canvasWidth);
    const bottom = clampInt(rawBottom, top + 1, canvasHeight);
    const targetWidth = Math.max(1, right - left);
    const targetHeight = Math.max(1, bottom - top);
    const boundingBox = { absolute: [left, top, right, bottom] as [number, number, number, number], normalized: [left / canvasWidth * 1000, top / canvasHeight * 1000, right / canvasWidth * 1000, bottom / canvasHeight * 1000] as [number, number, number, number] };
    if (layer.role === "base" || layer.index === 0) return { buffer: await sharp(buffer).png().toBuffer(), boundingBox: { absolute: [0, 0, canvasWidth, canvasHeight], normalized: [0, 0, 1000, 1000] }, boundingBoxSource: "absolute" };
    if (width === targetWidth && height === targetHeight) return { buffer: await sharp(buffer).png().toBuffer(), boundingBox, boundingBoxSource: source };
    // `size` is the crop's own resolution, NOT its display size on the base.
    // Seedream legitimately returns e.g. 651x889 pixels in a 186x253 box.
    const matchesDeclaredSize = Math.abs(width - layer.size.width) <= 2 && Math.abs(height - layer.size.height) <= 2;
    const ratioError = Math.abs((width / height) / (targetWidth / targetHeight) - 1);
    const roundingTolerance = Math.max(.02, 2 / targetWidth + 2 / targetHeight);
    if (matchesDeclaredSize && ["absolute", "normalized"].includes(source) && ratioError <= roundingTolerance) {
        return { buffer: await sharp(buffer).png().toBuffer(), boundingBox, boundingBoxSource: source };
    }
    if (width === canvasWidth && height === canvasHeight) {
        return { buffer: await sharp(buffer).extract({ left, top, width: targetWidth, height: targetHeight }).png().toBuffer(), boundingBox, boundingBoxSource: source };
    }
    // Documented boxes can differ from the PNG by one pixel at the endpoint.
    // Preserve the delivered pixels; the shared renderer maps to the exact box.
    if (Math.abs(width - targetWidth) <= 2 && Math.abs(height - targetHeight) <= 2) return { buffer: await sharp(buffer).png().toBuffer(), boundingBox, boundingBoxSource: source };
    if (!allowResize) throw new ImageLayerError("El tamaño de una capa no coincide con su posición. Se conservó la respuesta para revisarla sin volver a generar.", 502);
    return { buffer: await sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).resize(targetWidth, targetHeight, { fit: "fill" }).png().toBuffer(), boundingBox, boundingBoxSource: source };
}

async function poll(connection: ProviderConnection, providerTaskId: string, sourceWidth: number, sourceHeight: number, onCompleted?: (payload: JsonRecord) => Promise<void>): Promise<{ urls: string[]; layers: ImageLayerMetadata[]; canvasSize: { width: number; height: number }; baseProviderIndex: number }> {
    const started = Date.now();
    for (;;) {
        const payload = await requestJson(`/v1/tasks/${encodeURIComponent(providerTaskId)}?language=es`, connection);
        const body = taskBody(payload);
        const status = String(body.status ?? "").toLowerCase();
        if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new ImageLayerError("APIMart no pudo separar la imagen en capas.", 502);
        const completed = ["completed", "success", "succeeded", "done"].includes(status);
        if (completed) await onCompleted?.(payload);
        const parsed = parseLayerDecomposition(payload, sourceWidth, sourceHeight);
        if (completed) {
            if (parsed) return parsed;
            throw new ImageLayerError("APIMart terminó la tarea sin devolver capas válidas.", 502);
        }
        if (parsed && !["pending", "processing", "submitted", "queued", "in_progress"].includes(status)) return parsed;
        if (Date.now() - started > MAX_POLL_MS) throw new ImageLayerError("APIMart tardó demasiado en separar la imagen. Revisa el historial antes de reintentar.", 504);
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
}

function layerSet(sourceWidth: number, sourceHeight: number, canvasWidth: number, canvasHeight: number, parsed: { layers: ImageLayerMetadata[]; baseProviderIndex: number }): ImageLayerSet {
    return { version: 4, model: MODEL, sourceWidth, sourceHeight, canvasWidth, canvasHeight, coordinateSpace: "canonical-pixels", baseIndex: parsed.baseProviderIndex + 1, referenceIndex: 0, layers: parsed.layers };
}

async function persistLayerTask(args: { sourceTask?: ImageTask; parentTaskId: string; parentIndex: number; prompt: string; connectionId: string; providerTaskId?: string; layerSet: ImageLayerSet; buffers: Buffer[]; mode: "layer-decomposition" | "layer-edit" | "layer-normalize" }): Promise<{ task: ImageTask; imageUrl: string }> {
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
        provider_task_id: args.providerTaskId,
        created_at: new Date().toISOString(), media_type: "image" as const, result_paths: paths, result_urls: paths.map((_, index) => `/api/download/${taskIdValue}?index=${index}`),
        reuse_state: { edit_root_task_id: root, edit_root_index: rootIndex, edit_parent_task_id: args.parentTaskId, edit_parent_index: args.parentIndex, edit_mode: args.mode, edit_instruction: args.prompt, layer_source_task_id: sourceTaskId, layer_source_index: sourceIndex, layer_set: args.layerSet },
        events, _done: true,
    } as ImageTask & { events: TaskEvent[]; _done: boolean };
    setTask(task); await saveTasks();
    return { task, imageUrl: `/api/download/${taskIdValue}?index=0` };
}

export async function normalizeLayerTask(layerTaskId: string): Promise<{ taskId: string; layers: ImageLayerMetadata[] }> {
    await initStore();
    const task = getTask(layerTaskId);
    const layerSet = task?.reuse_state?.layer_set as ImageLayerSet | undefined;
    if (!task || task.media_type !== "image" || task.status !== "COMPLETED" || !layerSet || !Array.isArray(task.result_paths)) throw new ImageLayerError("La edición de capas ya no está disponible.", 404);
    const referenceIndex = layerSet.referenceIndex ?? 0;
    const canvasWidth = layerSet.canvasWidth ?? layerSet.sourceWidth;
    const canvasHeight = layerSet.canvasHeight ?? layerSet.sourceHeight;
    validateLayerPositions(layerSet.layers.map(layer => ({ ...layer, role: layer.index === referenceIndex ? "reference" : layer.index === layerSet.baseIndex ? "base" : "layer" })), canvasWidth, canvasHeight);
    const aligned = await Promise.all(layerSet.layers.map(async (layer) => {
        const file = task.result_paths?.[layer.index];
        if (!file || layer.index === referenceIndex) return { layer, buffer: file ? await fs.readFile(file) : undefined };
        const buffer = await fs.readFile(file);
        const [left, top, right, bottom] = layer.boundingBox.absolute;
        const hasPosition = left > 0 || top > 0 || right < canvasWidth || bottom < canvasHeight;
        const result = await fitLayerToBounds(buffer, { ...layer, boundingBoxSource: layer.boundingBoxSource ?? (hasPosition ? "absolute" : "fallback"), role: layer.index === layerSet.baseIndex ? "base" : "layer" }, canvasWidth, canvasHeight);
        return { layer: { ...layer, role: layer.index === layerSet.baseIndex ? "base" as const : "layer" as const, boundingBox: result.boundingBox, boundingBoxSource: result.boundingBoxSource, size: { width: Math.max(1, result.boundingBox.absolute[2] - result.boundingBox.absolute[0]), height: Math.max(1, result.boundingBox.absolute[3] - result.boundingBox.absolute[1]) } }, buffer: result.buffer };
    }));
    if (aligned.some((item) => !item.buffer)) throw new ImageLayerError("No se pudieron leer todas las capas guardadas.", 404);
    const normalizedSet: ImageLayerSet = { ...layerSet, version: 4, coordinateSpace: "canonical-pixels", referenceIndex, layers: aligned.map((item) => item.layer) };
    const saved = await persistLayerTask({ sourceTask: task, parentTaskId: layerTaskId, parentIndex: 0, prompt: "Normalizar posiciones de capas", connectionId: task.provider_connection_id ?? "local", layerSet: normalizedSet, buffers: aligned.map((item) => item.buffer as Buffer), mode: "layer-normalize" });
    return { taskId: saved.task.task_id, layers: (saved.task.reuse_state?.layer_set as ImageLayerSet).layers };
}

export async function decomposeImage(taskIdValue: string, index: number, prompt: string, size: string): Promise<{ taskId: string; imageUrl: string; layers: ImageLayerMetadata[] }> {
    const source = await sourceData(taskIdValue, index);
    if (source.width * source.height < 262_144 || source.width * source.height > 36_000_000 || source.png.length > 30 * 1024 * 1024) throw new ImageLayerError("Para separar capas, la imagen debe tener entre 262.144 y 36 millones de píxeles y pesar hasta 30 MB.");
    const recoverable = await listRecoverableLayerJobs(taskIdValue, index);
    if (recoverable.length) throw new ImageLayerError("Ya hay una separación pendiente de guardar. Usa Recuperar capas sin regenerar para no pagar otra vez.", 409);
    await assertLayerDiskSpace();
    const connection = await getConnectionForProvider("apimart");
    if (!connection?.credentials.apiKey) throw new ImageLayerError("Conecta APIMart antes de separar imágenes en capas.", 400);
    const payload = await requestJson("/v1/images/generations", connection, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: prompt || undefined, image_urls: [`data:image/png;base64,${source.png.toString("base64")}`], layer_decomposition: true, size: ["auto", "1K", "1.5K", "2K"].includes(size) ? size : "auto", output_format: "png" }) });
    const providerTaskId = taskId(payload);
    const job = { sourceTaskId: taskIdValue, sourceIndex: index, createdAt: new Date().toISOString(), connectionId: connection.id, prompt };
    if (providerTaskId) await saveLayerJob(providerTaskId, job);
    const parsed = providerTaskId ? await poll(connection, providerTaskId, source.width, source.height, response => saveLayerJob(providerTaskId, { ...job, response })) : parseLayerDecomposition(payload, source.width, source.height);
    if (!parsed) throw new ImageLayerError("APIMart no devolvió capas válidas.", 502);
    return finishLayerDecomposition(source, taskIdValue, index, prompt, connection.id, parsed, providerTaskId);
}

async function finishLayerDecomposition(source: Awaited<ReturnType<typeof sourceData>>, taskIdValue: string, index: number, prompt: string, connectionId: string, parsed: NonNullable<ReturnType<typeof parseLayerDecomposition>>, providerTaskId?: string) {
    if (parsed.layers.length < 2) throw new ImageLayerError("APIMart devolvió una imagen sin capas separadas.", 502);
    validateLayerPositions(parsed.layers, parsed.canvasSize.width, parsed.canvasSize.height);
    const providerBuffers = await downloadLayerAssets(parsed.urls, providerTaskId);
    await assertLayerDiskSpace(source.png.length + providerBuffers.reduce((sum, buffer) => sum + buffer.length, 0) * 2 + 64 * 1024 * 1024);
    const providerMetadata = await Promise.all(providerBuffers.map((buffer) => sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).metadata()));
    const invalidAlphaIndex = providerMetadata.findIndex((metadata, providerIndex) => providerIndex !== parsed.baseProviderIndex && !metadata.hasAlpha);
    if (invalidAlphaIndex >= 0) throw new ImageLayerError(`APIMart devolvió la capa ${invalidAlphaIndex} sin transparencia. Vuelve a separar la imagen.`, 502);
    const baseMetadata = providerMetadata[parsed.baseProviderIndex] ?? providerMetadata[0];
    const canvasWidth = baseMetadata.width ?? parsed.canvasSize.width;
    const canvasHeight = baseMetadata.height ?? parsed.canvasSize.height;
    if (canvasWidth !== parsed.canvasSize.width || canvasHeight !== parsed.canvasSize.height) throw new ImageLayerError("Las dimensiones de la base no coinciden con las coordenadas de APIMart.", 502);
    const providerLayers = parsed.layers.map((layer, providerIndex) => ({
        ...layer,
        index: providerIndex + 1,
        zIndex: layer.zIndex,
        role: providerIndex === parsed.baseProviderIndex ? "base" as const : "layer" as const,
        name: layer.name === "Imagen base" ? "Base separada" : layer.name,
    }));
    const aligned = await Promise.all(providerBuffers.map((buffer, providerIndex) => fitLayerToBounds(buffer, providerLayers[providerIndex], canvasWidth, canvasHeight)));
    const normalizedProviderLayers = providerLayers.map((layer, providerIndex) => ({ ...layer, boundingBoxSource: aligned[providerIndex].boundingBoxSource, boundingBox: aligned[providerIndex].boundingBox, size: { width: Math.max(1, aligned[providerIndex].boundingBox.absolute[2] - aligned[providerIndex].boundingBox.absolute[0]), height: Math.max(1, aligned[providerIndex].boundingBox.absolute[3] - aligned[providerIndex].boundingBox.absolute[1]) } }));
    const referenceLayer: ImageLayerMetadata = {
        index: 0,
        zIndex: -1,
        name: "Referencia original",
        description: "Imagen inicial conservada como referencia y capa bloqueada.",
        size: { width: source.width, height: source.height },
        role: "reference",
        boundingBox: { absolute: [0, 0, canvasWidth, canvasHeight], normalized: [0, 0, 1000, 1000] },
    };
    const normalizedLayers = [referenceLayer, ...normalizedProviderLayers];
    const normalizedSet: ImageLayerSet = { ...layerSet(source.width, source.height, canvasWidth, canvasHeight, { layers: normalizedProviderLayers, baseProviderIndex: parsed.baseProviderIndex }) , layers: normalizedLayers };
    const saved = await persistLayerTask({ sourceTask: source.task, parentTaskId: taskIdValue, parentIndex: index, prompt, connectionId, providerTaskId, layerSet: normalizedSet, buffers: [source.png, ...aligned.map((item) => item.buffer)], mode: "layer-decomposition" });
    return { taskId: saved.task.task_id, imageUrl: saved.imageUrl, layers: (saved.task.reuse_state?.layer_set as ImageLayerSet).layers };
}

type LayerJob = { providerTaskId: string; sourceTaskId: string; sourceIndex: number; createdAt: string; connectionId?: string; prompt?: string; response?: JsonRecord };
async function readLayerJob(id: string): Promise<LayerJob> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ImageLayerError("Identificador de recuperación inválido.");
    const job = JSON.parse(await fs.readFile(path.join(STORAGE_ROOT, "layer-jobs", `${id}.json`), "utf8")) as LayerJob;
    if (typeof job.providerTaskId !== "string" || createHash("sha256").update(job.providerTaskId).digest("hex") !== id || typeof job.sourceTaskId !== "string" || !Number.isInteger(job.sourceIndex)) throw new ImageLayerError("El registro de recuperación no es válido.");
    return job;
}

export async function listRecoverableLayerJobs(sourceTaskId: string, sourceIndex: number) {
    await initStore();
    const files = await fs.readdir(path.join(STORAGE_ROOT, "layer-jobs")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const completed = new Set([...getStore().values()].filter(task => task.reuse_state?.edit_mode === "layer-decomposition" && task.status === "COMPLETED").map(task => task.provider_task_id));
    const result: Array<{ id: string; createdAt: string }> = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
        const id = file.slice(0, -5);
        const job = await readLayerJob(id);
        const parent = getTask(job.sourceTaskId)?.reuse_state;
        if (!completed.has(job.providerTaskId) && ((job.sourceTaskId === sourceTaskId && job.sourceIndex === sourceIndex) || (parent?.edit_parent_task_id === sourceTaskId && parent?.edit_parent_index === sourceIndex))) result.push({ id, createdAt: job.createdAt });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const recoveries = new Map<string, Promise<Awaited<ReturnType<typeof finishLayerDecomposition>>>>();
export async function recoverLayerDecomposition(id: string) {
    const active = recoveries.get(id); if (active) return active;
    const recovery = (async () => {
        const job = await readLayerJob(id);
        const source = await sourceData(job.sourceTaskId, job.sourceIndex);
        const existing = [...getStore().values()].find(task => task.provider_task_id === job.providerTaskId && task.reuse_state?.edit_mode === "layer-decomposition" && task.status === "COMPLETED") as ImageTask | undefined;
        if (existing) return { taskId: existing.task_id, imageUrl: `/api/download/${existing.task_id}?index=0`, layers: (existing.reuse_state?.layer_set as ImageLayerSet).layers };
        let parsed = job.response ? parseLayerDecomposition(job.response, source.width, source.height) : null;
        if (!job.response) {
            const connection = await getConnectionForProvider("apimart", job.connectionId);
            if (!connection) throw new ImageLayerError("Activa la conexión APIMart para consultar la tarea existente.");
            parsed = await poll(connection, job.providerTaskId, source.width, source.height, response => saveLayerJob(job.providerTaskId, { ...job, response }));
        }
        if (!parsed) throw new ImageLayerError("La respuesta guardada no contiene capas recuperables.", 422);
        return finishLayerDecomposition(source, job.sourceTaskId, job.sourceIndex, job.prompt ?? "Recuperar capas", job.connectionId ?? "env:apimart", parsed, job.providerTaskId);
    })();
    recoveries.set(id, recovery);
    try { return await recovery; } finally { recoveries.delete(id); }
}

export async function editImageLayer(layerTaskId: string, layerIndex: number, prompt: string): Promise<{ taskId: string; imageUrl: string; layers: ImageLayerMetadata[] }> {
    await initStore();
    const parent = getTask(layerTaskId);
    const layerSet = parent?.reuse_state?.layer_set as ImageLayerSet | undefined;
    if (!parent || parent.media_type !== "image" || parent.status !== "COMPLETED" || !layerSet || !Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= layerSet.layers.length || layerIndex === layerSet.baseIndex || layerIndex === layerSet.referenceIndex || layerSet.layers[layerIndex]?.role === "base" || layerSet.layers[layerIndex]?.role === "reference") throw new ImageLayerError("Selecciona una capa editable válida.");
    if (!prompt.trim() || prompt.length > 3000) throw new ImageLayerError("Describe el cambio de la capa.");
    validateLayerPositions(layerSet.layers, layerSet.canvasWidth ?? layerSet.sourceWidth, layerSet.canvasHeight ?? layerSet.sourceHeight);
    const connection = await getConnectionForProvider("apimart");
    if (!connection?.credentials.apiKey) throw new ImageLayerError("Conecta APIMart antes de editar una capa.", 400);
    const layerPath = parent.result_paths?.[layerIndex];
    if (!layerPath) throw new ImageLayerError("No se encontró el archivo de la capa.", 404);
    const layer = await fs.readFile(layerPath);
    const payload = await requestJson("/v1/images/generations", connection, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: `${prompt.trim()} Preserve transparency and keep the layer composition aligned to its original canvas.`, image_urls: [`data:image/png;base64,${layer.toString("base64")}`], background: "transparent", output_format: "png", size: "auto" }) });
    const providerTaskId = taskId(payload);
    const parsed = providerTaskId ? await poll(connection, providerTaskId, layerSet.sourceWidth, layerSet.sourceHeight) : parseLayerDecomposition(payload, layerSet.sourceWidth, layerSet.sourceHeight);
    if (!parsed?.urls[0]) throw new ImageLayerError("APIMart no devolvió la capa editada.", 502);
    const canvasWidth = layerSet.canvasWidth ?? layerSet.sourceWidth;
    const canvasHeight = layerSet.canvasHeight ?? layerSet.sourceHeight;
    const editedBuffer = await imageBuffer(parsed.urls[0]);
    if (!(await sharp(editedBuffer).metadata()).hasAlpha) throw new ImageLayerError("APIMart devolvió la edición sin transparencia. La capa anterior se conserva.", 502);
    const edited = await fitLayerToBounds(editedBuffer, layerSet.layers[layerIndex], canvasWidth, canvasHeight, true);
    const buffers = await Promise.all((parent.result_paths ?? []).map((file, index) => index === layerIndex ? edited.buffer : fs.readFile(file)));
    const nextSet: ImageLayerSet = { ...layerSet, version: 4, coordinateSpace: "canonical-pixels", layers: layerSet.layers.map((item) => item.index === layerIndex ? { ...item, description: prompt.trim().slice(0, 400), boundingBox: edited.boundingBox, boundingBoxSource: edited.boundingBoxSource, size: { width: Math.max(1, edited.boundingBox.absolute[2] - edited.boundingBox.absolute[0]), height: Math.max(1, edited.boundingBox.absolute[3] - edited.boundingBox.absolute[1]) } } : item) };
    const saved = await persistLayerTask({ sourceTask: parent as ImageTask, parentTaskId: layerTaskId, parentIndex: 0, prompt, connectionId: connection.id, providerTaskId, layerSet: nextSet, buffers, mode: "layer-edit" });
    return { taskId: saved.task.task_id, imageUrl: saved.imageUrl, layers: nextSet.layers };
}
