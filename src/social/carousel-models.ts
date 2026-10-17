import { getImageAspectRatios } from "@/models/capabilities/image-helpers";
import type { ImageModelCapability } from "@/models/capabilities/image";

/**
 * A carousel needs a visual anchor (brand assets and the cover), not a batch
 * of unrelated variations. Keep this list intentionally small and based on
 * the runtime OpenRouter catalog rather than provider names shown in the UI.
 */
export function isCarouselModel(model: ImageModelCapability | undefined): model is ImageModelCapability {
    if (!model || model.provider !== "openrouter" || model.media_slots.some(slot => slot.required)) return false;
    const id = (model.provider_model_id ?? "").toLocaleLowerCase();
    const isGptImage = /^openai\/(?:gpt-image|gpt-?5(?:\.\d+)?-image)/.test(id);
    const isNanoBanana = /^google\/gemini-(?:2\.5|3(?:\.\d+)?)-(?:flash|pro)(?:-lite)?-image/.test(id);
    return (isGptImage || isNanoBanana)
        && model.media_slots.some(slot => slot.kind === "image")
        && getImageAspectRatios(model).length > 0;
}

export const carouselModelHint = "Para carruseles: GPT Image y Nano Banana con referencias visuales.";
