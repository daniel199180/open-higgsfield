import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { downloadPublicMedia } from "@/lib/media-download";
import { publishProviderInput } from "@/lib/provider-input";
import { acceptsInlineImageReference } from "@/lib/image-reference";
import type { GeneratedAsset } from "@/providers/types";
import { workflowStore, WORKFLOW_DIR } from "./store";
import { WorkflowError, type Asset } from "./types";

export async function saveAsset(data: Buffer, kind: "image" | "video", mime?: string): Promise<Asset> {
    if (!data.length || data.length > (kind === "image" ? 20 : 128) * 1024 * 1024) throw new WorkflowError("Archivo vacío o demasiado grande.");
    if (kind === "image") {
        const decoder = sharp(data, { limitInputPixels: 40_000_000 });
        const meta = await decoder.metadata();
        if (!["png", "jpeg", "webp", "avif"].includes(meta.format ?? "")) throw new WorkflowError("Solo imágenes PNG, JPEG, WebP o AVIF.");
        data = await decoder.rotate().png().toBuffer(); // strip metadata; keep transparency
        if (data.length > 20 * 1024 * 1024) throw new WorkflowError("La imagen decodificada supera 20 MB.");
        mime = "image/png";
    } else {
        const mp4 = data.subarray(4, 8).toString() === "ftyp";
        const webm = data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        if (!mp4 && !webm) throw new WorkflowError("El proveedor no devolvió un video válido.");
        mime = mp4 ? "video/mp4" : "video/webm";
    }
    const asset: Asset = { id: crypto.randomUUID(), kind, mime, bytes: data.length, createdAt: Date.now() };
    const directory = path.join(WORKFLOW_DIR, "assets");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await fs.open(path.join(directory, asset.id), "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await workflowStore().transaction(docs => { docs.set(`asset:${asset.id}`, asset); });
    return asset;
}

/** SVG is private and must be sanitized before calling this function. */
export async function saveVectorAsset(data: Buffer): Promise<Asset> {
    if (!data.length || data.length > 3 * 1024 * 1024 || !data.toString("utf8", 0, 200).includes("<svg")) throw new WorkflowError("SVG inválido o demasiado grande.");
    const asset: Asset = { id: crypto.randomUUID(), kind: "vector", mime: "image/svg+xml", bytes: data.length, createdAt: Date.now() };
    const directory = path.join(WORKFLOW_DIR, "assets");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await fs.open(path.join(directory, asset.id), "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await workflowStore().transaction(docs => { docs.set(`asset:${asset.id}`, asset); });
    return asset;
}

export function audioMime(data: Buffer): "audio/mpeg" | "audio/wav" {
    if (data.length < 12 || data.length > 20 * 1024 * 1024) throw new WorkflowError("Audio vacío o demasiado grande.");
    if (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
    throw new WorkflowError("Solo se admite audio MP3 o WAV válido.");
}

export async function saveAudioAsset(data: Buffer): Promise<Asset> {
    const mime = audioMime(data);
    const asset: Asset = { id: crypto.randomUUID(), kind: "audio", mime, bytes: data.length, createdAt: Date.now() };
    const directory = path.join(WORKFLOW_DIR, "assets");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await fs.open(path.join(directory, asset.id), "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await workflowStore().transaction(docs => { docs.set(`asset:${asset.id}`, asset); });
    return asset;
}

export async function readAsset(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new WorkflowError("Archivo inválido.", 404);
    const asset = await workflowStore().read<Asset>(`asset:${id}`);
    if (!asset) throw new WorkflowError("Archivo no encontrado.", 404);
    return { asset, data: await fs.readFile(path.join(WORKFLOW_DIR, "assets", id)) };
}

export async function persistGeneratedAssets(assets: GeneratedAsset[], kind: "image" | "video"): Promise<string[]> {
    if (!assets.length || assets.length > 4) throw new WorkflowError("Cantidad de resultados no admitida.");
    const ids: string[] = [];
    for (const item of assets) {
        const media = item.data ? { data: Buffer.from(item.data), mimeType: item.mimeType } : await downloadPublicMedia(item.url ?? "");
        ids.push((await saveAsset(media.data, kind, media.mimeType)).id);
    }
    return ids;
}

export async function referenceValue(id: string, provider: string, accept?: string, providerModelId?: string): Promise<string> {
    const { asset, data } = await readAsset(id);
    if (asset.kind !== "image") throw new WorkflowError("La entrada debe ser una imagen.");
    if (acceptsInlineImageReference(provider, providerModelId)) return `data:${asset.mime};base64,${data.toString("base64")}`;
    if (accept === "b64_only") return data.toString("base64");
    // URL-only legacy models retain the existing, explicitly configured upload service.
    return publishProviderInput(data, asset.mime);
}
