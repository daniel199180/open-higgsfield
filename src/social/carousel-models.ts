import type { ImageModelCapability } from "@/models/capabilities/image";

/**
 * Provider catalogs are not consistent about publishing image-input metadata.
 * Identify the two supported carousel families independently of that metadata,
 * then let their provider adapters submit references using their documented
 * image-input field.
 */
export function isCarouselProviderModel(provider: ImageModelCapability["provider"], providerModelId?: string, label?: string): boolean {
    if (provider !== "openrouter" && provider !== "apimart") return false;
    const identity = `${providerModelId ?? ""} ${label ?? ""}`.toLocaleLowerCase();
    const isGptImage = /(?:^|[\s/_-])gpt[\s/_-]?image(?:[\s/_-]?\d|\b)|openai[\s/_-]+gpt[\s/_-]?image/.test(identity);
    const isNanoBanana = /nano[\s/_-]?banana|gemini[\s/_-]?(?:2\.5|3(?:\.\d+)?)[\s/_-]?(?:flash|pro)(?:[\s/_-]?(?:lite|preview))?[\s/_-]?image/.test(identity);
    return isGptImage || isNanoBanana;
}

export function isCarouselModel(model: ImageModelCapability | undefined): model is ImageModelCapability {
    return !!model && isCarouselProviderModel(model.provider, model.provider_model_id, model.label);
}

export const carouselModelHint = "GPT Image y Nano Banana de OpenRouter o APIMart. Cada página se genera por separado.";
