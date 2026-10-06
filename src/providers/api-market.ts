import type { GeneratedAsset, GenerationProvider, ProviderGenerationRequest, ProviderPollRequest, ProviderPollResult, ProviderSubmission } from "./types";
import { getConnectionForProvider } from "@/lib/connection-store";
import { callApiMarketTool, listApiMarketTools } from "./api-market-client";
import { getImageUrl, getMediaUrls } from "./utils";
import { providerFetch } from "./secure-fetch";

type ApiMarketConnection = Awaited<ReturnType<typeof getConnectionForProvider>>;

function requireConnection(connection: ApiMarketConnection) {
    if (!connection?.credentials.apiKey) throw new Error("ERR_API_MARKET_API_KEY_NOT_CONFIGURED");
    if (!connection.config.workspace || !connection.config.slug) throw new Error("ERR_API_MARKET_PRODUCT_NOT_CONFIGURED");
    return connection;
}

function parseToolResult(result: unknown): unknown {
    if (!result || typeof result !== "object") return result;
    const value = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    if (value.isError) throw new Error("ERR_API_MARKET_TOOL_FAILED");
    if (!Array.isArray(value.content)) return result;
    for (const item of value.content) {
        if (item.type !== "text" || !item.text) continue;
        try { return JSON.parse(item.text); } catch { return item.text; }
    }
    return result;
}

function collectAssets(value: unknown, assets: GeneratedAsset[] = []): GeneratedAsset[] {
    if (typeof value === "string") {
        if (/^https?:\/\/\S+$/i.test(value)) {
            const mimeType = /\.(mp4|webm|mov)(?:\?|$)/i.test(value) ? "video/mp4" : undefined;
            assets.push({ url: value, mimeType });
        }
        return assets;
    }
    if (!value || typeof value !== "object") return assets;
    if (Array.isArray(value)) {
        for (const item of value) collectAssets(item, assets);
        return assets;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.b64_json === "string") {
        assets.push({ data: Buffer.from(record.b64_json, "base64"), mimeType: String(record.media_type ?? "image/png") });
    }
    for (const [key, child] of Object.entries(record)) {
        if (key === "b64_json" || !["images", "image", "video", "videos", "output", "outputs", "result", "results", "data", "url", "image_url", "video_url", "output_url", "download_url"].includes(key)) continue;
        collectAssets(child, assets);
    }
    return assets;
}

function findString(value: unknown, names: string[]): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findString(item, names);
            if (found) return found;
        }
        return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const name of names) if (typeof record[name] === "string") return record[name] as string;
    for (const child of Object.values(record)) {
        const found = findString(child, names);
        if (found) return found;
    }
    return undefined;
}

function requestPayload(request: ProviderGenerationRequest): Record<string, unknown> {
    const values = request.params.field_values ?? {};
    const urls = getMediaUrls(request.media);
    return Object.fromEntries(Object.entries({
        ...values,
        prompt: request.params.prompt || undefined,
        negative_prompt: request.params.negative_prompt || undefined,
        duration: request.params.duration ? Number(request.params.duration) : undefined,
        aspect_ratio: request.params.aspect_ratio || undefined,
        resolution: request.params.resolution || undefined,
        seed: request.params.seed,
        generate_audio: request.params.generate_audio ?? values.generate_audio,
        image_urls: urls.length ? urls : undefined,
        image_url: getImageUrl(request.media, "start_image", "image", "input_image"),
        video_url: request.media.video,
        audio_url: request.media.audio,
    }).filter(([, value]) => value !== undefined && value !== ""));
}

async function resolveTool(connection: NonNullable<ApiMarketConnection>, mediaType: "image" | "video"): Promise<string> {
    if (connection.config.toolName) return connection.config.toolName;
    const tools = await listApiMarketTools(connection.config, connection.credentials.apiKey);
    const matching = tools.find((tool) => {
        const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
        return haystack.includes(mediaType) && /(generate|create|predict|submit)/.test(haystack);
    }) ?? tools.find((tool) => /(generate|create|predict|submit)/i.test(tool.name));
    if (!matching) throw new Error("ERR_API_MARKET_GENERATION_TOOL_NOT_FOUND");
    return matching.name;
}

export class ApiMarketProvider implements GenerationProvider {
    readonly id = "api-market" as const;

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        const connection = requireConnection(await getConnectionForProvider(this.id, request.connectionId));
        const toolName = request.providerModelId || await resolveTool(connection, request.mediaType);
        const result = parseToolResult(await callApiMarketTool(
            connection.config,
            connection.credentials.apiKey,
            toolName,
            { body: { input: requestPayload(request) } },
        ));
        const assets = collectAssets(result);
        if (assets.length > 0) return { status: "COMPLETED", assets };
        const jobId = findString(result, ["id", "request_id", "prediction_id", "job_id"]);
        const statusUrl = findString(result, ["status_url", "polling_url", "poll_url"]);
        if (!jobId && !statusUrl) throw new Error("ERR_API_MARKET_EMPTY_GENERATION_RESPONSE");
        return {
            status: "CREATED",
            providerTaskId: jobId,
            operation: {
                connectionId: connection.id,
                toolName,
                statusToolName: connection.config.statusToolName || "",
                jobId,
                statusUrl,
            },
        };
    }

    async poll(request: ProviderPollRequest): Promise<ProviderPollResult> {
        const operation = (request.operation ?? {}) as {
            connectionId?: string;
            statusToolName?: string;
            jobId?: string;
            statusUrl?: string;
            result?: unknown;
        };
        const connection = requireConnection(await getConnectionForProvider(this.id, operation.connectionId));

        if (operation.statusUrl) {
            const response = await providerFetch("api-market", operation.statusUrl, { headers: { "x-api-market-key": connection.credentials.apiKey } });
            if (!response.ok) return { status: "FAILED", error: `ERR_API_MARKET_STATUS_FAILED: ${response.status}`, operation };
            const result = await response.json();
            const assets = collectAssets(result);
            const status = String(findString(result, ["status", "state"]) ?? "").toLowerCase();
            if (assets.length > 0 || ["completed", "succeeded", "success"].includes(status)) {
                return assets.length > 0 ? { status: "COMPLETED", assets, operation } : { status: "FAILED", error: "ERR_NO_GENERATED_ASSETS", operation };
            }
            if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "FAILED", error: "ERR_API_MARKET_GENERATION_FAILED", operation };
            return { status: "IN_PROGRESS", operation };
        }

        if (!operation.statusToolName) return { status: "ERROR", error: "ERR_API_MARKET_STATUS_TOOL_NOT_CONFIGURED", operation };
        const result = parseToolResult(await callApiMarketTool(
            connection.config,
            connection.credentials.apiKey,
            operation.statusToolName,
            { body: { input: { id: operation.jobId, request_id: operation.jobId, job_id: operation.jobId } } },
        ));
        const assets = collectAssets(result);
        if (assets.length > 0) return { status: "COMPLETED", assets, operation };
        const status = String(findString(result, ["status", "state"]) ?? "").toLowerCase();
        if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "FAILED", error: "ERR_API_MARKET_GENERATION_FAILED", operation };
        return { status: "IN_PROGRESS", operation };
    }
}
