import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { STORAGE_ROOT } from "./storage-paths";
import { vaultKey } from "./security-store";

const DIRECTORY = path.join(STORAGE_ROOT, "provider-inputs");
const TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_BYTES = 30 * 1024 * 1024;
const MIME_TO_EXT: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/webm": ".webm", "audio/mp4": ".m4a",
};
const EXT_TO_MIME: Record<string, string> = {
    ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};
const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|mov|mp3|wav|m4a)$/i;
let lastCleanup = 0;

export function publicReferenceOrigin(): string {
    const configured = process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
    let url: URL;
    try { url = new URL(configured || ""); }
    catch { throw new Error("ERR_PUBLIC_REFERENCE_ORIGIN_REQUIRED"); }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIP(hostname) !== 0) {
        throw new Error("ERR_PUBLIC_REFERENCE_ORIGIN_REQUIRED");
    }
    return url.origin;
}

async function signature(filename: string, expires: number): Promise<string> {
    return crypto.createHmac("sha256", await vaultKey()).update(`provider-input:v1:${filename}:${expires}`).digest("hex");
}

async function cleanupOldInputs(): Promise<void> {
    if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
    lastCleanup = Date.now();
    const entries = await fs.readdir(DIRECTORY).catch(() => []);
    await Promise.all(entries.filter(name => FILE_PATTERN.test(name)).map(async name => {
        const filename = path.join(DIRECTORY, name);
        const info = await fs.lstat(filename).catch(() => undefined);
        if (info?.isFile() && Date.now() - info.mtimeMs > RETENTION_MS) await fs.unlink(filename).catch(() => undefined);
    }));
}

/** A short-lived, signed URL for providers that cannot accept inline media. */
export async function publishProviderInput(data: Buffer, mimeType: string): Promise<string> {
    const origin = publicReferenceOrigin();
    const ext = MIME_TO_EXT[mimeType];
    if (!ext) throw new Error("ERR_INVALID_MEDIA_TYPE");
    if (!data.length || data.length > MAX_BYTES) throw new Error("ERR_MEDIA_TOO_LARGE");
    await fs.mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
    await cleanupOldInputs();
    const filename = `${crypto.randomUUID()}${ext}`;
    await fs.writeFile(path.join(DIRECTORY, filename), data, { flag: "wx", mode: 0o600 });
    const expires = Date.now() + TTL_MS;
    const url = new URL(`/api/provider-input/${filename}`, origin);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", await signature(filename, expires));
    return url.toString();
}

/** Returns no bytes at all for an expired, malformed or forged URL. */
export async function readProviderInput(filename: string, expiresValue: string | null, supplied: string | null): Promise<{ data: Buffer; mimeType: string } | null> {
    if (!FILE_PATTERN.test(filename) || !expiresValue || !/^\d{13}$/.test(expiresValue) || !supplied || !/^[0-9a-f]{64}$/i.test(supplied)) return null;
    const expires = Number(expiresValue);
    if (expires < Date.now() || expires > Date.now() + TTL_MS) return null;
    const expected = Buffer.from(await signature(filename, expires), "hex");
    if (!crypto.timingSafeEqual(Buffer.from(supplied, "hex"), expected)) return null;
    const mimeType = EXT_TO_MIME[path.extname(filename).toLowerCase()];
    if (!mimeType) return null;
    try {
        const data = await fs.readFile(path.join(DIRECTORY, filename));
        return data.length > 0 && data.length <= MAX_BYTES ? { data, mimeType } : null;
    } catch { return null; }
}
