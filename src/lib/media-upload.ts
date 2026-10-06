/**
 * Media upload utilities — shared between video and image route handlers.
 */
import sharp from "sharp";
import { saveInputLocally, uploadToTmpfiles, resolveLocalUpload } from "@/lib/upload";
import { assertSafeRemoteUrl } from "@/lib/safe-url";

/** Convert an image buffer to JPEG format */
export async function toJpeg(buffer: Buffer): Promise<Buffer> {
    if (buffer.length > 20 * 1024 * 1024) throw new Error("ERR_MEDIA_TOO_LARGE");
    const image = sharp(buffer, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp", "gif", "avif"].includes(metadata.format || "")) throw new Error("ERR_INVALID_MEDIA_TYPE");
    return image.jpeg({ quality: 92 }).toBuffer();
}

export interface ResolvedMedia {
    /** Remote URL suitable for API calls */
    remoteUrl: string;
    /** Local URL for display/reuse */
    localUrl: string;
}

/** Process an image file: convert to JPEG, save locally, upload remotely */
export async function processImageUpload(buffer: Buffer): Promise<ResolvedMedia> {
    const jpeg = await toJpeg(buffer);
    const localUrl = await saveInputLocally(jpeg, ".jpg");
    const remoteUrl = await uploadToTmpfiles(jpeg, "image.jpg", "image/jpeg");
    return { remoteUrl, localUrl };
}

/** Process a generic file: save locally, upload remotely */
export async function processFileUpload(
    buffer: Buffer,
    filename: string,
    mimeType: string
): Promise<ResolvedMedia> {
    if (buffer.length > 30 * 1024 * 1024) throw new Error("ERR_MEDIA_TOO_LARGE");
    const mp4 = buffer.subarray(4, 8).toString() === "ftyp";
    const webm = buffer.subarray(0, 4).toString("hex") === "1a45dfa3";
    const wav = buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE";
    const mp3 = buffer.subarray(0, 3).toString() === "ID3" || (buffer[0] === 255 && (buffer[1] & 224) === 224);
    if (!(mp4 && ["video/mp4", "video/quicktime", "audio/mp4"].includes(mimeType)) && !(webm && ["video/webm", "audio/webm"].includes(mimeType)) && !(wav && ["audio/wav", "audio/x-wav"].includes(mimeType)) && !(mp3 && mimeType === "audio/mpeg")) throw new Error("ERR_INVALID_MEDIA_TYPE");
    const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : ".bin";
    const localUrl = await saveInputLocally(buffer, ext);
    const remoteUrl = await uploadToTmpfiles(buffer, `file${ext}`, mimeType);
    return { remoteUrl, localUrl };
}

/** Resolve a URL that may be a local upload reference to a remote URL */
export async function resolveUrl(url: string): Promise<ResolvedMedia> {
    if (url.startsWith("/api/uploaded/") || url.startsWith("/api/download/")) {
        const remoteUrl = await resolveLocalUpload(url);
        return { remoteUrl, localUrl: url };
    }
    const safeUrl = await assertSafeRemoteUrl(url);
    return { remoteUrl: safeUrl.toString(), localUrl: safeUrl.toString() };
}
