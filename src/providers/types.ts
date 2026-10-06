import type { CanonicalMediaInputs, CanonicalParams } from "@/models/canonical";
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { GenerationUsage } from "@/billing/types";

export type ProviderId =
    | "freepik"
    | "google-ai-studio"
    | "google-vertex"
    | "vercel-ai-gateway"
    | "openrouter"
    | "higgsfield"
    | "api-market";
export type GenerationStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "ERROR" | "CANCELLED";

export interface GeneratedAsset {
    data?: Uint8Array;
    url?: string;
    mimeType?: string;
}

export interface ProviderGenerationRequest {
    mediaType: "image" | "video";
    modelId: string;
    providerModelId: string;
    providerMode?: ModelCapabilities["provider_mode"];
    capabilities: ModelCapabilities;
    params: CanonicalParams;
    media: CanonicalMediaInputs;
    /** Optional connection selected from the admin connection manager. */
    connectionId?: string;
}

export type ProviderSubmission = { usage?: GenerationUsage } & ({
    status: "COMPLETED";
    assets: GeneratedAsset[];
    providerTaskId?: string;
} | {
    status: "CREATED" | "IN_PROGRESS";
    operation: unknown;
    providerTaskId?: string;
});

export interface ProviderPollRequest {
    mediaType: "image" | "video";
    providerModelId: string;
    operation: unknown;
}

export type ProviderPollResult = { usage?: GenerationUsage } & ({
    status: "CREATED" | "IN_PROGRESS";
    operation?: unknown;
} | {
    status: "COMPLETED";
    assets: GeneratedAsset[];
    operation?: unknown;
} | {
    status: "FAILED" | "ERROR" | "CANCELLED";
    error: string;
    operation?: unknown;
});

export interface GenerationProvider {
    readonly id: ProviderId;
    submit(request: ProviderGenerationRequest): Promise<ProviderSubmission>;
    poll(request: ProviderPollRequest): Promise<ProviderPollResult>;
}
