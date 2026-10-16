import fs from "fs/promises";
import path from "path";
import { STORAGE_ROOT } from "@/lib/storage-paths";
import crypto from "node:crypto";
import { downloadPublicMedia } from "./media-download";
import { publishProviderInput } from "./provider-input";

function shortId() {
    return crypto.randomUUID();
}

const UPLOADS_DIR = path.join(STORAGE_ROOT, "uploads");
const DOWNLOADS_DIR = path.join(STORAGE_ROOT, "downloads");
const DOWNLOADS_IMAGES_DIR = path.join(DOWNLOADS_DIR, "images");
const DOWNLOADS_VIDEOS_DIR = path.join(DOWNLOADS_DIR, "videos");

// Ensure dirs exist when this module is first imported
(async () => {
    await fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(() => { });
    await fs.mkdir(DOWNLOADS_IMAGES_DIR, { recursive: true }).catch(() => { });
    await fs.mkdir(DOWNLOADS_VIDEOS_DIR, { recursive: true }).catch(() => { });
})();

export async function saveInputLocally(buffer: Buffer, ext: string): Promise<string> {
    if (!/^\.(jpg|jpeg|png|webp|gif|avif|mp4|webm|mov|mp3|wav|m4a|ogg|bin)$/i.test(ext)) throw new Error("ERR_INVALID_MEDIA_TYPE");
    const filename = `${shortId()}${ext}`;
    await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
    return `/api/uploaded/${filename}`;
}

export async function readLocalUpload(filename: string): Promise<Buffer> {
    const safe = path.basename(filename);
    return fs.readFile(path.join(UPLOADS_DIR, safe));
}

export async function saveDownload(taskId: string, suffix: string, buffer: Buffer): Promise<string> {
    const isVideo = /\.(mp4|webm|mov)$/i.test(suffix);
    const dir = isVideo ? DOWNLOADS_VIDEOS_DIR : DOWNLOADS_IMAGES_DIR;
    const filePath = path.join(dir, `${taskId}${suffix}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
}

export async function readDownload(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
}

export async function downloadUrl(url: string, taskId: string, index: number): Promise<string> {
    const res = await downloadPublicMedia(url);
    const buffer = res.data;
    const contentType = res.mimeType;
    const ext = contentType.includes("jpeg") ? ".jpg"
        : contentType.includes("png") ? ".png"
            : contentType.includes("webp") ? ".webp"
                : contentType.includes("mp4") ? ".mp4"
                    : ".bin";
    return saveDownload(taskId, `_${index}${ext}`, buffer);
}

export async function resolveLocalUpload(url: string): Promise<string> {
    if (url.startsWith("/api/uploaded/")) {
        const filename = url.replace("/api/uploaded/", "");
        const buffer = await readLocalUpload(filename);
        const ext = path.extname(filename).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".png" ? "image/png"
                : ext === ".mp4" ? "video/mp4"
                    : ext === ".mp3" ? "audio/mpeg"
                        : "application/octet-stream";
        return publishProviderInput(buffer, mime);
    }
    return url;
}

export { UPLOADS_DIR, DOWNLOADS_DIR, DOWNLOADS_IMAGES_DIR, DOWNLOADS_VIDEOS_DIR };
