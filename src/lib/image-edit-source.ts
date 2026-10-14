import "server-only";
import fs from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { getTask, initStore, saveTasks, setTask } from "@/lib/task-store";
import { saveDownload } from "@/lib/upload";
import { shortId } from "@/lib/payload-utils";
import type { ImageTask } from "@/types";

export class ImageEditInputError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

export interface ImageEditComment { x: number; y: number; text: string }

export function parseImageEditComments(value: string): ImageEditComment[] {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new ImageEditInputError("Revisa los comentarios de edición."); }
    if (!Array.isArray(parsed) || parsed.length > 8) throw new ImageEditInputError("Se permiten hasta 8 comentarios por edición.");
    return parsed.map((item) => {
        if (!item || typeof item !== "object") throw new ImageEditInputError("Revisa los comentarios de edición.");
        const row = item as Record<string, unknown>;
        if (typeof row.x !== "number" || !Number.isFinite(row.x) || row.x < 0 || row.x > 1 ||
            typeof row.y !== "number" || !Number.isFinite(row.y) || row.y < 0 || row.y > 1 ||
            typeof row.text !== "string" || !row.text.trim() || row.text.length > 400) throw new ImageEditInputError("Cada comentario necesita una ubicación y un texto de hasta 400 caracteres.");
        return { x: row.x, y: row.y, text: row.text.trim() };
    });
}

export async function normalizeImageEditInput(data: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
    if (!data.length || data.length > 20 * 1024 * 1024) throw new ImageEditInputError("La imagen debe pesar menos de 20 MB.", 413);
    try {
        const decoder = sharp(data, { limitInputPixels: 40_000_000, failOn: "error" });
        const meta = await decoder.metadata();
        if (!["png", "jpeg", "webp", "avif"].includes(meta.format ?? "") || !meta.width || !meta.height) throw new Error("invalid image");
        const png = await decoder.rotate().png().toBuffer();
        if (png.length > 20 * 1024 * 1024) throw new ImageEditInputError("La imagen procesada supera 20 MB.", 413);
        const dimensions = await sharp(png).metadata();
        return { png, width: dimensions.width!, height: dimensions.height! };
    } catch (error) {
        if (error instanceof ImageEditInputError) throw error;
        throw new ImageEditInputError("La imagen no tiene un formato válido.");
    }
}

export async function persistImageEditSource(data: Buffer, label = "Imagen subida para editar"): Promise<{ taskId: string; imageUrl: string }> {
    const image = await normalizeImageEditInput(data);
    const taskId = shortId();
    await initStore();
    const path = await saveDownload(taskId, "_0.png", image.png);
    const original: ImageTask & { events: NonNullable<ImageTask["events"]>; _done: boolean } = {
        task_id: taskId, status: "COMPLETED", freepik_status: "COMPLETED", model_id: "local:uploaded-image",
        prompt: label.slice(0, 160), created_at: new Date().toISOString(), media_type: "image", result_paths: [path],
        result_urls: [`/api/download/${taskId}?index=0`], reuse_state: { edit_uploaded_source: true }, events: [], _done: true,
    };
    setTask(original);
    await saveTasks();
    return { taskId, imageUrl: `/api/download/${taskId}?index=0` };
}

export async function taskImageForEdit(taskId: string, index: number): Promise<{ image: Buffer; rootTaskId: string; rootIndex: number }> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 9) throw new ImageEditInputError("Selecciona una imagen válida.");
    await initStore();
    const task = getTask(taskId);
    if (!task || task.media_type !== "image" || task.status !== "COMPLETED") throw new ImageEditInputError("La imagen original ya no está disponible.", 404);
    const file = task.result_paths?.[index];
    let image: Buffer;
    if (file) {
        image = await fs.readFile(file).catch(() => { throw new ImageEditInputError("No se encontró la imagen original.", 404); });
    } else {
        const url = task.result_urls?.[index] ?? "";
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
        if (!match || match[1].length > 28 * 1024 * 1024) throw new ImageEditInputError("No se encontró la imagen original.", 404);
        image = Buffer.from(match[1], "base64");
    }
    const root = task.reuse_state?.edit_root_task_id;
    const savedIndex = task.reuse_state?.edit_root_index;
    return { image, rootTaskId: typeof root === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(root) ? root : taskId,
        rootIndex: typeof savedIndex === "number" && Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex <= 9 ? savedIndex : index };
}

export async function maskForImageEdit(data: Buffer, width: number, height: number): Promise<Buffer> {
    if (!data.length || data.length > 10 * 1024 * 1024) throw new ImageEditInputError("La máscara supera 10 MB.", 413);
    try {
        const decoder = sharp(data, { limitInputPixels: 40_000_000, failOn: "error" });
        const meta = await decoder.metadata();
        if (meta.format !== "png" || !meta.hasAlpha || meta.width !== width || meta.height !== height) throw new Error("invalid mask");
        const alpha = (await decoder.stats()).channels[3];
        if (!alpha || alpha.min === 255 || alpha.max === 0) throw new Error("empty mask");
        return data;
    } catch {
        throw new ImageEditInputError("La máscara debe ser PNG del mismo tamaño, con una zona pintada y otra sin pintar.");
    }
}

/** OpenRouter has no native mask field: mark editable areas and numbered comments in a second reference. */
export async function editGuideForOpenRouter(source: Buffer, mask: Buffer | null, comments: ImageEditComment[], width: number, height: number): Promise<Buffer> {
    if (width * height > 16_000_000) throw new ImageEditInputError("La imagen es demasiado grande para pintar una zona. Reduce su tamaño o usa Imagen completa.", 413);
    const layers: OverlayOptions[] = [];
    if (mask) {
        const pixels = await sharp(mask).ensureAlpha().raw().toBuffer();
        const overlay = Buffer.alloc(width * height * 4);
        for (let position = 0; position < overlay.length; position += 4) {
            overlay[position] = 239;
            overlay[position + 1] = 68;
            overlay[position + 2] = 68;
            overlay[position + 3] = Math.round((255 - pixels[position + 3]) * 0.72);
        }
        layers.push({ input: overlay, raw: { width, height, channels: 4 } });
    }
    if (comments.length) {
        const radius = Math.max(13, Math.min(42, Math.round(Math.min(width, height) * 0.027)));
        const markers = comments.map((item, index) => {
            const x = Math.round(item.x * (width - 1));
            const y = Math.round(item.y * (height - 1));
            return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#c62828" stroke="white" stroke-width="${Math.max(2, Math.round(radius / 8))}"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="sans-serif" font-size="${Math.round(radius * 1.2)}" font-weight="bold">${index + 1}</text>`;
        }).join("");
        layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${markers}</svg>`) });
    }
    const guide = await sharp(source).composite(layers).png().toBuffer();
    if (guide.length > 20 * 1024 * 1024) throw new ImageEditInputError("La guía de la zona supera 20 MB. Reduce el tamaño de la imagen.", 413);
    return guide;
}

export async function regionGuideForOpenRouter(source: Buffer, mask: Buffer, width: number, height: number): Promise<Buffer> {
    return editGuideForOpenRouter(source, mask, [], width, height);
}
