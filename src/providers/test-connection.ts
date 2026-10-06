import { listApiMarketTools, initializeApiMarket } from "@/providers/api-market-client";
import type { ProviderConnection } from "@/lib/connection-store";
import { providerFetch } from "./secure-fetch";

export async function testProviderConnection(connection: ProviderConnection): Promise<{ message: string; details?: unknown }> {
    const apiKey = connection.credentials.apiKey?.trim();
    if (!apiKey) throw new Error("ERR_PROVIDER_API_KEY_REQUIRED");

    if (connection.provider === "openrouter") {
        const baseUrl = (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
        const response = await providerFetch("openrouter", `${baseUrl}/key`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_OPENROUTER_CONNECTION_FAILED: ${response.status}`);
        return { message: "OpenRouter conectado" };
    }

    if (connection.provider === "higgsfield") {
        const baseUrl = (connection.config.baseUrl || "https://api.higgsfield.ai").replace(/\/$/, "");
        const response = await providerFetch("higgsfield", `${baseUrl}/v1/custom-references/list?page=1&page_size=1`, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_HIGGSFIELD_CONNECTION_FAILED: ${response.status}`);
        return { message: "Higgsfield conectado" };
    }

    if (connection.provider === "api-market") {
        await initializeApiMarket(connection.config, apiKey);
        const tools = await listApiMarketTools(connection.config, apiKey);
        return { message: "API.market conectado", details: { tools: tools.length } };
    }

    throw new Error("ERR_PROVIDER_CONNECTION_TEST_UNSUPPORTED");
}
