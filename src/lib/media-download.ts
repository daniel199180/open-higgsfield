import "server-only";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertSafeRemoteUrl } from "./safe-url";

/** Detect the stored format from bytes, never from a signed URL or CDN header. */
export function detectGeneratedMediaType(data: Buffer): string | undefined {
    if (data.length < 12) return;
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
    if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && data.subarray(0, Math.min(data.length, 256)).includes(Buffer.from("webm"))) return "video/webm";
    if (data.toString("ascii", 4, 8) === "ftyp") {
        const boxSize = data.readUInt32BE(0);
        if (boxSize < 16 || boxSize > data.length) return;
        const brand = data.toString("ascii", 8, 12);
        const brands = data.toString("ascii", 8, Math.min(boxSize, 64));
        if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
        if (["heic", "heix", "mif1", "msf1"].includes(brand)) return;
        if (brand === "qt  ") return "video/quicktime";
        return "video/mp4";
    }
}

export async function readGeneratedMediaResponse(response: Response): Promise<{ data: Buffer; mimeType: string }> {
    if (!response.ok || !response.body) throw new Error("ERR_INVALID_GENERATED_MEDIA");
    const limit = 256 * 1024 * 1024;
    if (Number(response.headers.get("content-length") || 0) > limit) throw new Error("ERR_MEDIA_TOO_LARGE");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) { await reader.cancel(); throw new Error("ERR_MEDIA_TOO_LARGE"); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    const data = Buffer.concat(chunks, length);
    const mimeType = detectGeneratedMediaType(data);
    if (!mimeType) throw new Error("ERR_INVALID_GENERATED_MEDIA");
    return { data, mimeType };
}

// Pin the validated DNS result to the socket, preserve the TLS hostname and never
// forward credentials. Redirect targets are checked independently.
export async function downloadPublicMedia(value: string, redirects = 0): Promise<{ data: Buffer; mimeType: string }> {
    if (redirects > 3) throw new Error("ERR_MEDIA_REDIRECT_LIMIT");
    const url = await assertSafeRemoteUrl(value);
    if (url.protocol !== "https:") throw new Error("ERR_INVALID_MEDIA_URL");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const address = isIP(hostname) ? { address: hostname, family: isIP(hostname) } : await lookup(hostname);
    await assertSafeRemoteUrl(`https://${address.family === 6 ? `[${address.address}]` : address.address}/`);
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            family: address.family,
            lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
            signal: AbortSignal.timeout(120_000),
        }, (response) => {
            const status = response.statusCode ?? 500;
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                downloadPublicMedia(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.destroy(); reject(new Error(`ERR_MEDIA_HTTP_${status}`)); return;
            }
            const limit = 256 * 1024 * 1024;
            if (Number(response.headers["content-length"] || 0) > limit) { response.destroy(); reject(new Error("ERR_MEDIA_TOO_LARGE")); return; }
            const chunks: Buffer[] = []; let length = 0;
            response.on("data", (chunk: Buffer) => {
                length += chunk.length;
                if (length > limit) { response.destroy(); reject(new Error("ERR_MEDIA_TOO_LARGE")); return; }
                chunks.push(chunk);
            });
            response.on("end", () => {
                const data = Buffer.concat(chunks, length);
                const mimeType = detectGeneratedMediaType(data);
                if (!mimeType) { reject(new Error("ERR_INVALID_GENERATED_MEDIA")); return; }
                resolve({ data, mimeType });
            });
            response.on("error", () => reject(new Error("ERR_MEDIA_DOWNLOAD_FAILED")));
        });
        request.on("error", () => reject(new Error("ERR_MEDIA_DOWNLOAD_FAILED")));
    });
}
