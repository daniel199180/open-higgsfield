import type { GeneratedAsset, GenerationProvider, ProviderGenerationRequest, ProviderPollRequest, ProviderPollResult, ProviderSubmission } from "./types";
import { getConnectionForProvider } from "@/lib/connection-store";
import { getImageUrl, getMediaUrls } from "./utils";
import { providerFetch } from "./secure-fetch";

type ApiMartConnection = Awaited<ReturnType<typeof getConnectionForProvider>>;

function requireConnection(connection: ApiMartConnection) {
    if (!connection?.credentials.apiKey) throw new Error("ERR_APIMART_API_KEY_NOT_CONFIGURED");
    return connection;
}

function headers(connection: NonNullable<ApiMartConnection>): Record<string, string> {
    return { Authorization: `Bearer ${connection.credentials.apiKey}`, "Content-Type": "application/json" };
}

/** Convert upstream failures to a closed set; provider details never reach the UI. */
function requestFailure(status: number, payload: unknown): string {
    if (status === 401) return "ERR_APIMART_KEY_REJECTED";
    if (status === 402) return "ERR_APIMART_CREDITS";
    if (status === 429) return "ERR_APIMART_RATE_LIMIT";
    if (status === 408 || status === 504) return "ERR_APIMART_TIMEOUT";
    const compact = JSON.stringify(payload ?? {}).toLowerCase();
    if (/prompt.{0,80}(too long|length|maximum|max)|maximum.{0,80}prompt/.test(compact)) return "ERR_APIMART_PROMPT_TOO_LONG";
    if (/image_urls|reference image|input image|reference/.test(compact)) return "ERR_APIMART_REFERENCE_UNSUPPORTED";
    if (status === 400 || status === 422) return "ERR_APIMART_PARAMETERS";
    return "ERR_APIMART_REQUEST_FAILED";
}

async function requestJson(url: string, connection: NonNullable<ApiMartConnection>, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await providerFetch("apimart", url, { ...init, headers: { ...headers(connection), ...(init.headers ?? {}) } });
    } catch (error) {
        const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
        throw new Error(timeout ? "ERR_APIMART_TIMEOUT" : "ERR_APIMART_NETWORK");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload) || "error" in payload) {
        throw new Error(requestFailure(response.status, payload));
    }
    return payload as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
}

function taskId(payload: Record<string, unknown>): string | undefined {
    for (const item of records(payload.data)) {
        const id = item.task_id ?? item.id;
        if (typeof id === "string" && id) return id;
    }
    const id = payload.task_id ?? payload.id;
    return typeof id === "string" && id ? id : undefined;
}

function assets(value: unknown, result: GeneratedAsset[] = []): GeneratedAsset[] {
    if (typeof value === "string") {
        if (/^https:\/\/[^\s]+$/i.test(value)) result.push({ url: value, mimeType: /\.(?:mp4|webm|mov)(?:\?|$)/i.test(value) ? "video/mp4" : undefined });
        return result;
    }
    if (!value || typeof value !== "object") return result;
    if (Array.isArray(value)) { for (const child of value) assets(child, result); return result; }
    const record = value as Record<string, unknown>;
    for (const key of ["images", "videos", "image", "video", "url", "image_url", "video_url", "output_url", "download_url"]) {
        if (key in record) assets(record[key], result);
    }
    return result;
}

function imagePayload(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const references = getMediaUrls(request.media);
    return Object.fromEntries(Object.entries({
        model: request.providerModelId,
        prompt: request.params.prompt,
        size: request.params.size || request.params.aspect_ratio || undefined,
        resolution: request.params.resolution || undefined,
        quality: values.quality || undefined,
        n: Number(values.n ?? 1),
        image_urls: references.length ? references : undefined,
    }).filter(([, value]) => value !== undefined && value !== ""));
}

function videoPayload(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const first = getImageUrl(request.media, "start_image", "image", "input_image");
    const last = getImageUrl(request.media, "end_image");
    const seedance = /seedance/i.test(request.providerModelId);
    const kling = /kling/i.test(request.providerModelId);
    return Object.fromEntries(Object.entries({
        model: request.providerModelId,
        prompt: request.params.prompt,
        duration: request.params.duration ? Number(request.params.duration) : undefined,
        resolution: request.params.resolution || undefined,
        ...(seedance ? { size: request.params.aspect_ratio || undefined } : { aspect_ratio: request.params.aspect_ratio || undefined }),
        ...(seedance ? { generate_audio: typeof values.generate_audio === "boolean" ? values.generate_audio : undefined } : kling ? { audio: typeof values.generate_audio === "boolean" ? values.generate_audio : undefined } : {}),
        image_urls: first || last ? [first, last].filter((item): item is string => !!item) : undefined,
    }).filter(([, value]) => value !== undefined && value !== ""));
}

function taskBody(payload: Record<string, unknown>): Record<string, unknown> {
    const data = payload.data;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : payload;
}

export class ApiMartProvider implements GenerationProvider {
    readonly id = "apimart" as const;

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        const connection = requireConnection(await getConnectionForProvider(this.id, request.connectionId));
        const payload = await requestJson(request.mediaType === "image" ? "/v1/images/generations" : "/v1/videos/generations", connection, {
            method: "POST",
            body: JSON.stringify(request.mediaType === "image" ? imagePayload(request) : videoPayload(request)),
        });
        const id = taskId(payload);
        if (!id) {
            const completed = assets(payload);
            if (completed.length) return { status: "COMPLETED", assets: completed };
            throw new Error("ERR_APIMART_MISSING_TASK_ID");
        }
        return { status: "CREATED", providerTaskId: id, operation: { connectionId: connection.id, taskId: id } };
    }

    async poll(request: ProviderPollRequest): Promise<ProviderPollResult> {
        const operation = (request.operation ?? {}) as { connectionId?: string; taskId?: string };
        const connection = requireConnection(await getConnectionForProvider(this.id, operation.connectionId));
        if (!operation.taskId) return { status: "ERROR", error: "ERR_APIMART_MISSING_TASK_ID", operation };
        const payload = await requestJson(`/v1/tasks/${encodeURIComponent(operation.taskId)}?language=es`, connection);
        const task = taskBody(payload);
        const status = String(task.status ?? "").toLowerCase();
        if (["pending", "processing", "submitted", "queued", "in_progress"].includes(status)) return { status: "IN_PROGRESS", operation };
        if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "FAILED", error: "ERR_APIMART_GENERATION_FAILED", operation };
        const completed = assets(task.result ?? task.data ?? task);
        if (status === "completed" && completed.length) return { status: "COMPLETED", assets: completed, operation };
        return { status: "ERROR", error: "ERR_APIMART_INVALID_TASK_RESPONSE", operation };
    }
}
