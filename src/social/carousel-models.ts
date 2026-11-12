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
    if (!model) return false;
    // APIMart's runtime catalog is already separated by media type, so every
    // model reaching this predicate is an image model. Models that do not
    // accept references can still generate a missing slide independently;
    // validation below continues to reject them when a brand/character image
    // must be supplied.
    if (model.provider === "apimart") return true;
    return isCarouselProviderModel(model.provider, model.provider_model_id, model.label);
}

export const carouselModelHint = "GPT Image y Nano Banana de OpenRouter, o modelos de imagen compatibles de APIMart. Cada página se genera por separado.";
