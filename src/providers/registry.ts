import type { ModelCapabilities } from "@/models/capabilities/types";
import { FreepikProvider } from "./freepik";
import { GoogleProvider } from "./google";
import type { GenerationProvider, ProviderId } from "./types";
import { VercelAiGatewayProvider } from "./vercel-ai-gateway";
import { OpenRouterProvider } from "./openrouter";
import { HiggsfieldProvider } from "./higgsfield";
import { ApiMarketProvider } from "./api-market";

const providers = new Map<ProviderId, GenerationProvider>([
    ["freepik", new FreepikProvider()],
    ["google-ai-studio", new GoogleProvider("google-ai-studio")],
    ["google-vertex", new GoogleProvider("google-vertex")],
    ["vercel-ai-gateway", new VercelAiGatewayProvider()],
    ["openrouter", new OpenRouterProvider()],
    ["higgsfield", new HiggsfieldProvider()],
    ["api-market", new ApiMarketProvider()],
]);

export function resolveProvider(caps: ModelCapabilities): {
    provider: GenerationProvider;
    providerId: ProviderId;
    providerModelId: string;
    connectionId?: string;
} {
    const providerId = caps.provider ?? "freepik";
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`ERR_UNKNOWN_PROVIDER: ${providerId}`);
    return {
        provider,
        providerId,
        providerModelId: caps.provider_model_id ?? caps.id,
        connectionId: caps.provider_connection_id,
    };
}

export function getProvider(providerId: ProviderId): GenerationProvider {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`ERR_UNKNOWN_PROVIDER: ${providerId}`);
    return provider;
}
