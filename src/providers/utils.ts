import type { CanonicalMediaInputs } from "@/models/canonical";
import { assertSafeRemoteUrl } from "@/lib/safe-url";

export function getMediaUrls(media: CanonicalMediaInputs): string[] {
    const values = Object.values(media.images ?? {}) as unknown[];
    return values.flatMap((value) => Array.isArray(value) ? value : [value])
        .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function getImageUrl(media: CanonicalMediaInputs, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = (media.images as Record<string, unknown> | undefined)?.[key];
        if (typeof value === "string" && value) return value;
        if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
    return undefined;
}

export async function fetchMedia(url: string): Promise<{ data: Uint8Array; mimeType: string }> {
    if (url.startsWith("data:")) {
        const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
        if (!match || match[2].length > 28 * 1024 * 1024) throw new Error("ERR_INVALID_MEDIA_TYPE");
        const data = Buffer.from(match[2], "base64");
        if (data.length > 20 * 1024 * 1024) throw new Error("ERR_MEDIA_TOO_LARGE");
        return { data, mimeType: `image/${match[1]}` };
    }
    const safeUrl = await assertSafeRemoteUrl(url);
    const response = await fetch(safeUrl, { redirect: "error" });
    if (!response.ok) throw new Error(`ERR_MEDIA_DOWNLOAD: ${response.status}`);
    return {
        data: new Uint8Array(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    };
}

export function toSerializable(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (key, item) => {
        if (key === "sdkHttpResponse" || key.startsWith("_")) return undefined;
        return item;
    }));
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try { return JSON.stringify(error); } catch { return "ERR_PROVIDER"; }
}
