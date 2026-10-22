import { listApiMarketTools, initializeApiMarket } from "@/providers/api-market-client";
import type { ProviderConnection } from "@/lib/connection-store";
import { providerFetch } from "./secure-fetch";
import { apiMarketSubscriptions } from "./api-market-subscriptions";

export async function testProviderConnection(connection: ProviderConnection): Promise<{ message: string; details?: unknown }> {
    const apiKey = connection.credentials.apiKey?.trim();
    if (!apiKey) throw new Error("ERR_PROVIDER_API_KEY_REQUIRED");

    if (connection.provider === "openai") {
        const response = await providerFetch("openai", "/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_OPENAI_CONNECTION_FAILED: ${response.status}`);
        return { message: "OpenAI conectado. La disponibilidad de edición se comprueba al generar." };
    }

    if (connection.provider === "openrouter") {
        const baseUrl = (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
        const response = await providerFetch("openrouter", `${baseUrl}/key`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_OPENROUTER_CONNECTION_FAILED: ${response.status}`);
        return { message: "OpenRouter conectado" };
    }

    if (connection.provider === "elevenlabs") {
        const response = await providerFetch("elevenlabs", "/v1/user", {
            headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_ELEVENLABS_CONNECTION_FAILED: ${response.status}`);
        return { message: "ElevenLabs conectado" };
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
        if (connection.config.mode === "catalog") {
            const products = await apiMarketSubscriptions(apiKey);
            return { message: `API.market conectado · ${products.length} productos en tus suscripciones. La comprobación no genera imágenes ni vídeos.`, details: { products: products.length } };
        }
        await initializeApiMarket(connection.config, apiKey);
        const tools = await listApiMarketTools(connection.config, apiKey);
        return { message: "API.market conectado", details: { tools: tools.length } };
    }

    if (connection.provider === "apimart") {
        const response = await providerFetch("apimart", "/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_APIMART_CONNECTION_FAILED: ${response.status}`);
        return { message: "APIMart conectado. El catálogo de imagen y vídeo se actualizará al guardar." };
    }

    if (connection.provider === "deepseek") {
        const baseUrl = (connection.config.baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
        const response = await providerFetch("deepseek", `${baseUrl}/v1/models`, {
            headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ERR_DEEPSEEK_CONNECTION_FAILED: ${response.status}`);
        return { message: "DeepSeek conectado" };
    }

    throw new Error("ERR_PROVIDER_CONNECTION_TEST_UNSUPPORTED");
}
