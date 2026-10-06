import type { GenerationProvider, ProviderGenerationRequest, ProviderPollRequest, ProviderPollResult, ProviderSubmission, GeneratedAsset } from "./types";
import { getConnectionForProvider } from "@/lib/connection-store";
import { getImageUrl, getMediaUrls } from "./utils";
import { providerFetch } from "./secure-fetch";

type HiggsfieldConnection = Awaited<ReturnType<typeof getConnectionForProvider>>;

function requireConnection(connection: HiggsfieldConnection) {
    if (!connection?.credentials.apiKey) throw new Error("ERR_HIGGSFIELD_API_KEY_NOT_CONFIGURED");
    return connection;
}

function baseUrl(connection: NonNullable<HiggsfieldConnection>): string {
    return (connection.config.baseUrl || "https://api.higgsfield.ai").replace(/\/$/, "");
}

function headers(connection: NonNullable<HiggsfieldConnection>): Record<string, string> {
    return {
        Authorization: `Key ${connection.credentials.apiKey}`,
        "Content-Type": "application/json",
    };
}

async function requestJson<T>(url: string, connection: NonNullable<HiggsfieldConnection>, init: RequestInit = {}): Promise<T> {
    const response = await providerFetch("higgsfield", url, {
        ...init,
        headers: { ...headers(connection), ...(init.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`ERR_HIGGSFIELD_REQUEST_FAILED: ${response.status}`);
    }
    return payload as T;
}

function assetsFromResult(payload: Record<string, unknown>): GeneratedAsset[] {
    const assets: GeneratedAsset[] = [];
    const images = Array.isArray(payload.images) ? payload.images : [];
    for (const image of images) {
        if (typeof image === "string") assets.push({ url: image, mimeType: "image/png" });
        else if (image && typeof image === "object" && typeof (image as { url?: unknown }).url === "string") {
            assets.push({ url: (image as { url: string }).url, mimeType: "image/png" });
        }
    }
    const video = payload.video;
    if (typeof video === "string") assets.push({ url: video, mimeType: "video/mp4" });
    else if (video && typeof video === "object" && typeof (video as { url?: unknown }).url === "string") {
        assets.push({ url: (video as { url: string }).url, mimeType: "video/mp4" });
    }
    const outputUrl = payload.output_url;
    if (typeof outputUrl === "string") assets.push({ url: outputUrl });
    return assets;
}

function isTerminal(status: string | undefined): boolean {
    return ["completed", "failed", "nsfw", "canceled", "cancelled"].includes(String(status).toLowerCase());
}

function requestBody(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const urls = getMediaUrls(request.media);
    const firstImage = getImageUrl(request.media, "start_image", "image", "input_image");
    const body: Record<string, unknown> = {
        ...values,
        prompt: request.params.prompt || undefined,
        negative_prompt: request.params.negative_prompt || undefined,
        duration: request.params.duration ? Number(request.params.duration) : undefined,
        aspect_ratio: request.params.aspect_ratio || undefined,
        resolution: request.params.resolution || undefined,
        seed: request.params.seed,
        generate_audio: request.params.generate_audio ?? values.generate_audio,
        image_urls: urls.length > 0 ? urls : undefined,
        image_url: firstImage,
        video_url: request.media.video,
        audio_url: request.media.audio,
    };
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== ""));
}

export class HiggsfieldProvider implements GenerationProvider {
    readonly id = "higgsfield" as const;

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        const connection = requireConnection(await getConnectionForProvider(this.id, request.connectionId));
        const response = await requestJson<Record<string, unknown>>(`${baseUrl(connection)}/${request.providerModelId.replace(/^\/+/, "")}`, connection, {
            method: "POST",
            body: JSON.stringify(requestBody(request)),
        });
        const status = String(response.status ?? "queued").toLowerCase();
        const requestId = typeof response.request_id === "string" ? response.request_id : undefined;
        const statusUrl = typeof response.status_url === "string"
            ? response.status_url
            : requestId ? `${baseUrl(connection)}/requests/${requestId}/status` : undefined;
        const assets = assetsFromResult(response);
        if (assets.length > 0 || status === "completed") {
            if (assets.length === 0) throw new Error("ERR_NO_GENERATED_ASSETS");
            return { status: "COMPLETED", assets, providerTaskId: requestId };
        }
        if (!statusUrl || !requestId) throw new Error("ERR_HIGGSFIELD_MISSING_REQUEST_ID");
        return {
            status: "CREATED",
            providerTaskId: requestId,
            operation: { connectionId: connection.id, requestId, statusUrl },
        };
    }

    async poll(request: ProviderPollRequest): Promise<ProviderPollResult> {
        const operation = (request.operation ?? {}) as { connectionId?: string; requestId?: string; statusUrl?: string };
        const connection = requireConnection(await getConnectionForProvider(this.id, operation.connectionId));
        const statusUrl = operation.statusUrl || (operation.requestId
            ? `${baseUrl(connection)}/requests/${operation.requestId}/status`
            : undefined);
        if (!statusUrl) return { status: "ERROR", error: "ERR_HIGGSFIELD_MISSING_STATUS_URL", operation };
        const response = await requestJson<Record<string, unknown>>(
            statusUrl.startsWith("http") ? statusUrl : `${baseUrl(connection)}${statusUrl.startsWith("/") ? "" : "/"}${statusUrl}`,
            connection,
        );
        const status = String(response.status ?? "queued").toLowerCase();
        if (!isTerminal(status)) return { status: "IN_PROGRESS", operation: { ...operation, requestId: String(response.request_id ?? operation.requestId) } };
        if (status === "failed" || status === "nsfw") {
            return { status: "FAILED", error: `ERR_HIGGSFIELD_${status.toUpperCase()}`, operation };
        }
        if (status === "canceled" || status === "cancelled") return { status: "CANCELLED", error: "ERR_HIGGSFIELD_CANCELLED", operation };
        const assets = assetsFromResult(response);
        if (assets.length === 0) return { status: "FAILED", error: "ERR_NO_GENERATED_ASSETS", operation };
        return { status: "COMPLETED", assets, operation };
    }
}
