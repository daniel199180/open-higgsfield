import { publishProviderInput } from "@/lib/provider-input";
import type { ProviderId } from "@/providers/types";

/** Only models with documented data-URI reference support are listed here. */
export function acceptsInlineImageReference(provider: string | undefined, providerModelId?: string): boolean {
    return provider === "openrouter" || provider === "openai" || provider === "google-ai-studio" || provider === "google-vertex" || provider === "vercel-ai-gateway" ||
        (provider === "apimart" && /^(?:doubao-)?seedream-5-0-pro$|^qwen-image-3\.0(?:-pro)?$/i.test(providerModelId ?? ""));
}

export async function providerImageReference(provider: ProviderId | undefined, image: Buffer, mimeType: "image/jpeg" | "image/png", providerModelId?: string): Promise<string> {
    if (acceptsInlineImageReference(provider, providerModelId)) return `data:${mimeType};base64,${image.toString("base64")}`;
    return publishProviderInput(image, mimeType);
}

/** Return a provider-compatible reference without making local images public when possible. */
export async function imageReferenceForProvider(provider: ProviderId | undefined, jpeg: Buffer, providerModelId?: string): Promise<string> {
    return providerImageReference(provider, jpeg, "image/jpeg", providerModelId);
}
