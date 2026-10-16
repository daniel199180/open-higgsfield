import "server-only";
import fs from "node:fs/promises";
import { downloadPublicMedia } from "@/lib/media-download";
import { getTask, initStore } from "@/lib/task-store";
import { readAsset, saveAsset } from "./assets";
import { WorkflowError, type Asset } from "./types";

/** Pin a gallery selection to a durable workflow asset before it enters a graph. */
export async function importGalleryImage(id: string): Promise<Asset> {
    const assetMatch = /^asset:([0-9a-f-]{36})$/i.exec(id);
    if (assetMatch) {
        const { asset } = await readAsset(assetMatch[1]);
        if (asset.kind !== "image") throw new WorkflowError("Selecciona una imagen de la galería.");
        return asset;
    }

    const taskMatch = /^task:([a-zA-Z0-9_-]{1,100}):(0|[1-9]\d{0,3})$/.exec(id);
    if (!taskMatch) throw new WorkflowError("La imagen de la galería no es válida.");
    await initStore();
    const task = getTask(taskMatch[1]);
    if (!task || task.media_type !== "image" || task.status !== "COMPLETED" || task.reuse_state?.editor_internal) {
        throw new WorkflowError("Esta imagen ya no está disponible en la galería.", 404);
    }
    const index = Number(taskMatch[2]);
    const path = task.result_paths?.[index];
    let data: Buffer | undefined;
    if (path) {
        try {
            const stat = await fs.stat(path);
            if (stat.size > 20 * 1024 * 1024) throw new WorkflowError("La imagen supera 20 MB.");
            data = await fs.readFile(path);
        } catch (error) {
            if (error instanceof WorkflowError) throw error;
            // An old local path may have been moved; try its persisted result URL.
        }
    }
    if (!data) {
        const url = task.result_urls?.[index];
        if (url?.startsWith("data:image/")) {
            const match = /^data:image\/(?:png|jpeg|webp|avif);base64,([a-zA-Z0-9+/=]+)$/.exec(url);
            if (!match || match[1].length > 28 * 1024 * 1024) throw new WorkflowError("La imagen de la galería no es válida.");
            data = Buffer.from(match[1], "base64");
        } else if (url?.startsWith("https://")) {
            try { data = (await downloadPublicMedia(url)).data; }
            catch { throw new WorkflowError("No se pudo recuperar la imagen original de la galería.", 404); }
        } else {
            throw new WorkflowError("No se encuentra el archivo de esta imagen en la galería.", 404);
        }
    }
    return saveAsset(data, "image");
}
