import "server-only";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertSafeRemoteUrl } from "./safe-url";

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
            const mimeType = response.headers["content-type"]?.split(";")[0] || "application/octet-stream";
            if (status !== 200 || !/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime)|application\/octet-stream)$/.test(mimeType)) {
                response.destroy(); reject(new Error("ERR_INVALID_GENERATED_MEDIA")); return;
            }
            const limit = 256 * 1024 * 1024;
            if (Number(response.headers["content-length"] || 0) > limit) { response.destroy(); reject(new Error("ERR_MEDIA_TOO_LARGE")); return; }
            const chunks: Buffer[] = []; let length = 0;
            response.on("data", (chunk: Buffer) => {
                length += chunk.length;
                if (length > limit) { response.destroy(); reject(new Error("ERR_MEDIA_TOO_LARGE")); return; }
                chunks.push(chunk);
            });
            response.on("end", () => resolve({ data: Buffer.concat(chunks, length), mimeType }));
            response.on("error", () => reject(new Error("ERR_MEDIA_DOWNLOAD_FAILED")));
        });
        request.on("error", () => reject(new Error("ERR_MEDIA_DOWNLOAD_FAILED")));
    });
}
