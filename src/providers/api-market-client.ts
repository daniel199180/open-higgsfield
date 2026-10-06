import { providerFetch, providerBase } from "./secure-fetch";
export interface ApiMarketTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse<T> {
    result?: T;
    error?: { code?: number; message?: string; data?: unknown };
}

export function apiMarketEndpoint(config: Record<string, string>): string {
    const base = providerBase("api-market", config.baseUrl);
    const workspace = (config.workspace || "").replace(/^\/+|\/+$/g, "");
    const slug = (config.slug || "").replace(/^\/+|\/+$/g, "");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspace) || !/^[a-zA-Z0-9_-]{1,150}$/.test(slug)) throw new Error("ERR_API_MARKET_PRODUCT_NOT_CONFIGURED");
    return `${base}/${workspace}/${slug}`;
}

async function rpc<T>(endpoint: string, apiKey: string, method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await providerFetch("api-market", endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-market-key": apiKey,
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method,
            ...(params ? { params } : {}),
        }),
    });
    const payload = await response.json().catch(() => ({})) as JsonRpcResponse<T>;
    if (!response.ok || payload.error) {
        throw new Error(`ERR_API_MARKET_REQUEST_FAILED: ${response.status}`);
    }
    if (payload.result === undefined) throw new Error("ERR_API_MARKET_EMPTY_RESPONSE");
    return payload.result;
}

export async function initializeApiMarket(config: Record<string, string>, apiKey: string) {
    return rpc(apiMarketEndpoint(config), apiKey, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "Open-Higgsfield", version: "0.1.0" },
    });
}

export async function listApiMarketTools(config: Record<string, string>, apiKey: string): Promise<ApiMarketTool[]> {
    const result = await rpc<{ tools?: ApiMarketTool[] }>(apiMarketEndpoint(config), apiKey, "tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
}

export async function callApiMarketTool(
    config: Record<string, string>,
    apiKey: string,
    name: string,
    argumentsValue: Record<string, unknown>
): Promise<unknown> {
    return rpc(apiMarketEndpoint(config), apiKey, "tools/call", {
        name,
        arguments: argumentsValue,
    });
}
