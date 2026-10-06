import type { GenerationProvider, ProviderGenerationRequest, ProviderPollRequest, ProviderPollResult, ProviderSubmission } from "./types";
import { getConnectionForProvider } from "@/lib/connection-store";
import { getImageUrl, getMediaUrls } from "./utils";
import { providerFetch } from "./secure-fetch";
import { openRouterFailure } from "./openrouter-errors";
import { openRouterUsage, UsageReportedError } from "@/billing/usage";

type OpenRouterConnection = Awaited<ReturnType<typeof getConnectionForProvider>>;

function requireConnection(connection: OpenRouterConnection) {
    if (!connection?.credentials.apiKey) throw new Error("ERR_OPENROUTER_API_KEY_NOT_CONFIGURED");
    return connection;
}

function baseUrl(connection: NonNullable<OpenRouterConnection>): string {
    return (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
}

function headers(connection: NonNullable<OpenRouterConnection>): Record<string, string> {
    const result: Record<string, string> = {
        Authorization: `Bearer ${connection.credentials.apiKey}`,
        "Content-Type": "application/json",
    };
    if (connection.config.httpReferer) result["HTTP-Referer"] = connection.config.httpReferer;
    if (connection.config.appTitle) result["X-OpenRouter-Title"] = connection.config.appTitle;
    return result;
}

async function requestJson<T>(url: string, connection: NonNullable<OpenRouterConnection>, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await providerFetch("openrouter", url, {
            ...init,
            headers: { ...headers(connection), ...(init.headers ?? {}) },
        });
    } catch (error) {
        const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
        throw new Error(timeout ? "ERR_OPENROUTER_TIMEOUT" : "ERR_OPENROUTER_NETWORK");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || (payload && typeof payload === "object" && payload.error)) {
        const diagnostic = openRouterFailure(response.status, payload);
        console.warn("[openrouter] request failed", diagnostic);
        throw new Error(diagnostic.code);
    }
    if (!payload || typeof payload !== "object") throw new Error("ERR_OPENROUTER_INVALID_RESPONSE");
    return payload as T;
}

function imagePayload(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const payload: Record<string, unknown> = {
        model: request.providerModelId,
        prompt: request.params.prompt,
        resolution: request.params.resolution || values.resolution || undefined,
        aspect_ratio: request.params.aspect_ratio || values.aspect_ratio || undefined,
        size: request.params.size || undefined,
        seed: request.params.seed,
        n: Number(values.n ?? 1),
        quality: values.quality || undefined,
        output_format: values.output_format || undefined,
        background: values.background || undefined,
    };
    const references = getMediaUrls(request.media);
    if (references.length > 0) {
        payload.input_references = references.map((url) => ({
            type: "image_url",
            image_url: { url },
        }));
    }
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ""));
}

function videoPayload(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const payload: Record<string, unknown> = {
        model: request.providerModelId,
        prompt: request.params.prompt,
        duration: request.params.duration ? Number(request.params.duration) : undefined,
        resolution: request.params.resolution || undefined,
        aspect_ratio: request.params.aspect_ratio || undefined,
        size: request.params.size || undefined,
        seed: request.params.seed,
        generate_audio: typeof values.generate_audio === "boolean" ? values.generate_audio : undefined,
    };
    const first = getImageUrl(request.media, "start_image", "image", "input_image");
    const last = getImageUrl(request.media, "end_image");
    if (first || last) {
        payload.frame_images = [
            ...(first ? [{ type: "image_url", image_url: { url: first }, frame_type: "first_frame" }] : []),
            ...(last ? [{ type: "image_url", image_url: { url: last }, frame_type: "last_frame" }] : []),
        ];
    }
    const references = getMediaUrls(request.media).filter((url) => url !== first && url !== last);
    if (references.length > 0) {
        payload.input_references = references.map((url) => ({ type: "image_url", image_url: { url } }));
    }
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ""));
}

export class OpenRouterProvider implements GenerationProvider {
    readonly id = "openrouter" as const;

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        const connection = requireConnection(await getConnectionForProvider(this.id, request.connectionId));
        if (request.mediaType === "image") {
            const response = await requestJson<{
                usage?: unknown;
                data?: Array<{ b64_json?: string; media_type?: string }>;
            }>(`${baseUrl(connection)}/images`, connection, {
                method: "POST",
                body: JSON.stringify(imagePayload(request)),
            });
            if (!Array.isArray(response.data)) throw new UsageReportedError("ERR_OPENROUTER_INVALID_RESPONSE", openRouterUsage(response.usage));
            const assets = response.data
                .filter((item) => item && typeof item.b64_json === "string" && item.b64_json.length > 0)
                .map((item) => ({
                    data: Buffer.from(item.b64_json!, "base64"),
                    mimeType: item.media_type ?? "image/png",
                }));
            if (assets.length === 0) throw new UsageReportedError("ERR_NO_IMAGE_GENERATED", openRouterUsage(response.usage));
            return { status: "COMPLETED", assets, usage: openRouterUsage(response.usage) };
        }

        const response = await requestJson<{
            usage?: unknown;
            id?: string;
            polling_url?: string;
            status?: string;
        }>(`${baseUrl(connection)}/videos`, connection, {
            method: "POST",
            body: JSON.stringify(videoPayload(request)),
        });
        if (!response.id) throw new Error("ERR_OPENROUTER_MISSING_JOB_ID");
        return {
            status: response.status === "completed" ? "IN_PROGRESS" : "CREATED",
            providerTaskId: response.id,
            usage: openRouterUsage(response.usage),
            operation: {
                connectionId: connection.id,
                jobId: response.id,
                pollingUrl: response.polling_url || `${baseUrl(connection)}/videos/${response.id}`,
            },
        };
    }

    async poll(request: ProviderPollRequest): Promise<ProviderPollResult> {
        const operation = (request.operation ?? {}) as { connectionId?: string; jobId?: string; pollingUrl?: string };
        const connection = requireConnection(await getConnectionForProvider(this.id, operation.connectionId));
        const jobId = operation.jobId;
        const pollingUrl = operation.pollingUrl || (jobId ? `${baseUrl(connection)}/videos/${jobId}` : undefined);
        if (!pollingUrl) return { status: "ERROR", error: "ERR_OPENROUTER_MISSING_POLL_URL", operation };

        const response = await requestJson<{
            usage?: unknown;
            id?: string;
            status?: string;
            error?: string | { message?: string };
            unsigned_urls?: string[];
        }>(new URL(pollingUrl, `${baseUrl(connection)}/`).href, connection);

        if (response.status === "pending" || response.status === "in_progress" || response.status === "queued") {
            return { status: "IN_PROGRESS", operation: { ...operation, jobId: response.id ?? jobId }, usage: openRouterUsage(response.usage) };
        }
        if (response.status === "failed" || response.status === "cancelled" || response.status === "expired") {
            return { status: "FAILED", error: "ERR_OPENROUTER_VIDEO_FAILED", operation, usage: openRouterUsage(response.usage) };
        }
        if (response.status !== "completed") return { status: "IN_PROGRESS", operation, usage: openRouterUsage(response.usage) };

        const urls = response.unsigned_urls ?? [];
        if (urls.length > 0) return { status: "COMPLETED", assets: urls.map((url) => ({ url, mimeType: "video/mp4" })), operation, usage: openRouterUsage(response.usage) };

        if (!jobId) return { status: "FAILED", error: "ERR_NO_VIDEO_GENERATED", operation, usage: openRouterUsage(response.usage) };
        try {
            const content = await providerFetch("openrouter", `${baseUrl(connection)}/videos/${encodeURIComponent(jobId)}/content`, { headers: headers(connection) });
            if (!content.ok) throw new Error("download failed");
            return {
                status: "COMPLETED",
                assets: [{ data: Buffer.from(await content.arrayBuffer()), mimeType: content.headers.get("content-type") ?? "video/mp4" }],
                operation,
                usage: openRouterUsage(response.usage),
            };
        } catch { throw new UsageReportedError("ERR_OPENROUTER_VIDEO_DOWNLOAD_FAILED", openRouterUsage(response.usage)); }
    }
}
