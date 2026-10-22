import { getConnectionForProvider, getStoredConnections, type ProviderConnection } from "@/lib/connection-store";
import { providerFetch } from "@/providers/secure-fetch";
import type { TextModel, WebSource } from "./types";

type TextProvider = "openrouter" | "apimart" | "deepseek";
type CompletionMessage = { role: "system" | "user" | "assistant"; content: string };
export interface TextCompletionOptions { webSearch?: boolean; reasoning?: boolean; skillPrompt?: string; attachmentsContext?: string; }
export interface TextCompletionResult { response: Response; sources: WebSource[]; }

function runtimeId(provider: TextProvider, connectionId: string, modelId: string): string { return `${provider}:text:${encodeURIComponent(connectionId)}:${encodeURIComponent(modelId)}`; }
function parseRuntimeId(id: string): { provider: TextProvider; connectionId: string; modelId: string } | undefined {
    const match = /^(openrouter|apimart|deepseek):text:([^:]+):(.+)$/.exec(id);
    if (!match) return undefined;
    try { return { provider: match[1] as TextProvider, connectionId: decodeURIComponent(match[2]), modelId: decodeURIComponent(match[3]) }; } catch { return undefined; }
}
function baseUrl(provider: TextProvider, connection: ProviderConnection): string {
    const fallback = provider === "apimart" ? "https://api.apimart.ai/v1" : provider === "deepseek" ? "https://api.deepseek.com" : "https://openrouter.ai/api/v1";
    return (connection.config.baseUrl || fallback).replace(/\/$/, "");
}
function deepSeekV1(connection: ProviderConnection): string { const base = baseUrl("deepseek", connection); return base.endsWith("/v1") ? base : `${base}/v1`; }
function headers(connection: ProviderConnection, provider: TextProvider): Record<string, string> {
    const result: Record<string, string> = { Authorization: `Bearer ${connection.credentials.apiKey}`, "Content-Type": "application/json" };
    if (provider === "openrouter" && connection.config.httpReferer) result["HTTP-Referer"] = connection.config.httpReferer;
    if (provider === "openrouter" && connection.config.appTitle) result["X-OpenRouter-Title"] = connection.config.appTitle;
    return result;
}
async function providerConnections(provider: TextProvider): Promise<ProviderConnection[]> {
    const stored = (await getStoredConnections(provider)).filter((connection) => connection.enabled);
    const env = await getConnectionForProvider(provider);
    if (env && env.enabled && !stored.some((connection) => connection.id === env.id)) stored.push(env);
    return stored.filter((connection) => Boolean(connection.credentials.apiKey));
}
function isTextModel(model: Record<string, unknown>): boolean {
    const architecture = model.architecture as { output_modalities?: unknown[]; modality?: unknown } | undefined;
    const outputValue = architecture?.output_modalities ?? model.output_modalities;
    const output = Array.isArray(outputValue) ? outputValue.map((value) => String(value).toLowerCase()) : [];
    if (output.length > 0) return output.includes("text");
    const text = `${model.id ?? model.model ?? ""} ${model.name ?? ""} ${model.type ?? ""} ${model.modality ?? architecture?.modality ?? ""}`.toLowerCase();
    return !/(?:image|video|audio|embedding|tts|speech|transcri)/.test(text);
}
async function listProviderTextModels(provider: TextProvider): Promise<TextModel[]> {
    const connections = await providerConnections(provider);
    const groups = await Promise.all(connections.map(async (connection) => {
        try {
            const path = provider === "openrouter" ? `${baseUrl(provider, connection)}/models?output_modalities=text` : `${provider === "deepseek" ? deepSeekV1(connection) : baseUrl(provider, connection)}/models`;
            const response = await providerFetch(provider, path, { headers: headers(connection, provider), signal: AbortSignal.timeout(15_000) });
            if (!response.ok) return [] as TextModel[];
            const payload = await response.json().catch(() => ({})) as { data?: unknown };
            const records = Array.isArray(payload.data) ? payload.data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
            return records.filter(isTextModel).map((model): TextModel | undefined => {
                const providerModelId = String(model.id ?? model.model ?? model.canonical_slug ?? "");
                if (!providerModelId) return undefined;
                const contextLength = typeof model.context_length === "number" && Number.isFinite(model.context_length) ? model.context_length : undefined;
                return { id: runtimeId(provider, connection.id, providerModelId), label: String(model.name ?? model.display_name ?? providerModelId), provider, providerModelId, providerConnectionId: connection.id, ...(contextLength !== undefined ? { contextLength } : {}) };
            }).filter((model): model is TextModel => Boolean(model));
        } catch { return [] as TextModel[]; }
    }));
    return groups.flat();
}
export async function listTextModels(): Promise<TextModel[]> {
    const groups = await Promise.all([listProviderTextModels("openrouter"), listProviderTextModels("apimart"), listProviderTextModels("deepseek")]);
    const seen = new Set<string>();
    return groups.flat().filter((model) => { const key = `${model.provider}:${model.providerConnectionId}:${model.providerModelId}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function providerError(provider: TextProvider, status: number): string {
    const prefix = provider === "apimart" ? "APIMART" : provider === "deepseek" ? "DEEPSEEK" : "OPENROUTER";
    if (status === 401 || status === 403) return `ERR_${prefix}_${provider === "openrouter" ? "AUTH" : "KEY_REJECTED"}`;
    if (status === 402) return `ERR_${prefix}_CREDITS`;
    if (status === 404) return `ERR_${prefix}_MODEL_UNAVAILABLE`;
    if (status === 408 || status === 504) return `ERR_${prefix}_TIMEOUT`;
    if (status === 429) return `ERR_${prefix}_RATE_LIMIT`;
    if (status >= 500) return `ERR_${prefix}_REQUEST_FAILED`;
    return `ERR_${prefix}_PARAMETERS`;
}
function extractSources(payload: unknown): WebSource[] {
    const object = payload && typeof payload === "object" ? payload as { results?: unknown[]; data?: unknown[] } : {};
    const records = object.results ?? object.data ?? [];
    return records.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item) => ({ title: String(item.title ?? item.name ?? item.url ?? "Fuente"), url: String(item.url ?? item.link ?? ""), snippet: String(item.snippet ?? item.content ?? item.text ?? "").slice(0, 500) })).filter((source) => /^https?:\/\//.test(source.url)).slice(0, 8);
}
async function searchDeepSeek(query: string): Promise<{ context: string; sources: WebSource[] }> {
    const searchConnection = await getConnectionForProvider("deepseek");
    if (!searchConnection?.credentials.apiKey) throw new Error("ERR_DEEPSEEK_API_KEY_NOT_CONFIGURED");
    const response = await providerFetch("deepseek", `${deepSeekV1(searchConnection)}/tools/search`, { method: "POST", headers: headers(searchConnection, "deepseek"), body: JSON.stringify({ query: query.slice(0, 128), max_results: 6, need_content: true }) });
    if (!response.ok) throw new Error(providerError("deepseek", response.status));
    const payload = await response.json().catch(() => ({}));
    const sources = extractSources(payload);
    const context = sources.map((source, index) => `[${index + 1}] ${source.title}\nURL: ${source.url}\n${source.snippet || ""}`).join("\n\n").slice(0, 16_000);
    return { context, sources };
}
export async function streamTextCompletion(modelId: string, messages: CompletionMessage[], options: TextCompletionOptions = {}): Promise<TextCompletionResult> {
    const parsed = parseRuntimeId(modelId);
    if (!parsed) throw new Error("ERR_TEXT_MODEL_INVALID");
    const connection = await getConnectionForProvider(parsed.provider, parsed.connectionId);
    const prefix = parsed.provider === "apimart" ? "APIMART" : parsed.provider === "deepseek" ? "DEEPSEEK" : "OPENROUTER";
    if (!connection?.credentials.apiKey) throw new Error(`ERR_${prefix}_API_KEY_NOT_CONFIGURED`);
    let sources: WebSource[] = [];
    const nextMessages = [...messages];
    if (options.skillPrompt) nextMessages.unshift({ role: "system", content: `Instrucciones de estilo seleccionadas por el usuario:\n${options.skillPrompt}` });
    if (options.attachmentsContext) nextMessages.push({ role: "user", content: `Contexto de archivos adjuntos:\n${options.attachmentsContext}` });
    if (options.webSearch) {
        const query = [...messages].reverse().find((message) => message.role === "user")?.content || "";
        const search = await searchDeepSeek(query);
        sources = search.sources;
        if (search.context) nextMessages.unshift({ role: "system", content: `Usa estas fuentes web como apoyo. No inventes datos ni enlaces. Si las fuentes no bastan, dilo claramente:\n${search.context}` });
    }
    const reasoningBody = options.reasoning ? parsed.provider === "deepseek" ? { thinking: { type: "enabled" }, reasoning_effort: "high" } : { reasoning_effort: "high" } : {};
    const body = { model: parsed.modelId, messages: nextMessages, stream: true, stream_options: { include_usage: true }, ...reasoningBody };
    const url = parsed.provider === "deepseek" ? `${deepSeekV1(connection)}/chat/completions` : `${baseUrl(parsed.provider, connection)}/chat/completions`;
    let response: Response;
    try { response = await providerFetch(parsed.provider, url, { method: "POST", headers: headers(connection, parsed.provider), body: JSON.stringify(body) }); }
    catch (error) { const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name); throw new Error(timeout ? `ERR_${prefix}_TIMEOUT` : `ERR_${prefix}_NETWORK`); }
    if (!response.ok || !response.body) throw new Error(providerError(parsed.provider, response.status));
    return { response, sources };
}
