import "server-only";
import type { ProviderGenerationRequest, GenerationProvider, ProviderSubmission } from "@/providers/types";
import { getConnectionForProvider } from "@/lib/connection-store";
import { billingStore } from "./store";
import { imageQuote } from "./pricing";
import { UsageReportedError } from "./usage";

/** Durable intent before a billable call; costs survive failed downloads and gallery deletion. */
export async function trackedSubmit(id: string, source: "studio" | "workflow", provider: GenerationProvider, request: ProviderGenerationRequest): Promise<ProviderSubmission> {
    const connection = ["openrouter", "higgsfield", "api-market"].includes(provider.id)
        ? await getConnectionForProvider(provider.id, request.connectionId) : undefined;
    const connectionId = connection?.id ?? request.connectionId ?? "environment";
    const values = request.params.field_values ?? {};
    const quote = request.mediaType === "image" && (provider.id !== "openrouter" || connection) ? await imageQuote({ provider: provider.id, connectionId: connection?.id ?? request.connectionId, model: request.providerModelId,
        resolution: request.params.resolution || String(values.resolution || ""), quality: String(values.quality || ""), aspectRatio: request.params.aspect_ratio || String(values.aspect_ratio || ""), size: request.params.size }) : undefined;
    const requestedCount = Number(values.n ?? 1);
    const n = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 10 ? requestedCount : 1;
    await billingStore().begin({ id, source, provider: provider.id, connection: connectionId, model: request.providerModelId, label: request.capabilities.label, media: request.mediaType, created: new Date().toISOString(), status: "SUBMITTING",
        estimateMin: quote?.minUsd === undefined ? undefined : quote.minUsd * n, estimateMax: quote?.maxUsd === undefined ? undefined : quote.maxUsd * n });
    try {
        const result = await provider.submit({ ...request, connectionId: connection?.id ?? request.connectionId });
        await billingStore().update(id, result.status, result.usage);
        return result;
    } catch (error) {
        // A timeout does not prove that the provider did not charge. Never write cost=0 here.
        await billingStore().update(id, "UNCONFIRMED", error instanceof UsageReportedError ? error.usage : undefined).catch(() => undefined);
        throw error;
    }
}
