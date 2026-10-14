import type { ModelCapabilities } from "@/models/capabilities/types";

const providerNames: Record<NonNullable<ModelCapabilities["provider"]>, string> = {
    freepik: "Freepik",
    "google-ai-studio": "Google AI Studio",
    "google-vertex": "Google Vertex",
    "vercel-ai-gateway": "Vercel AI Gateway",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    higgsfield: "Higgsfield",
    "api-market": "API.market",
    apimart: "APIMart",
};

/** Runtime catalog entries are created only from enabled provider connections. */
export function hasActiveModelApi(model: Pick<ModelCapabilities, "provider" | "provider_connection_id"> | undefined): boolean {
    return Boolean(model?.provider && model.provider_connection_id);
}

export function modelProviderName(model: Pick<ModelCapabilities, "provider">): string {
    return model.provider ? providerNames[model.provider] : "Sin proveedor";
}
