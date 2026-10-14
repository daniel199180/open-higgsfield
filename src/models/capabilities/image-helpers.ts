/**
 * Frontend helper functions for image capabilities.
 * Derive UI-friendly data shapes from ImageModelCapability.
 */
import type { ImageModelCapability } from "./image";
import type { MediaSlotCapability } from "./types";

/** Edit variant definition for image models */
export interface EditVariant {
    post_path: string;
    poll_path: string;
    slots: MediaSlotCapability[];
}

const EDIT_VARIANTS: Record<string, EditVariant> = {
    "v1__ai__text_to_image__seedream_v5_lite": {
        post_path: "/v1/ai/text-to-image/seedream-v5-lite-edit",
        poll_path: "/v1/ai/text-to-image/seedream-v5-lite-edit/{task_id}",
        slots: [{ id: "reference_images", label: "Reference images", kind: "image", multiple: true, required: true, accept: "b64_only" }],
    },
    "v1__ai__text_to_image__seedream_v4_5": {
        post_path: "/v1/ai/text-to-image/seedream-v4-5-edit",
        poll_path: "/v1/ai/text-to-image/seedream-v4-5-edit/{task_id}",
        slots: [{ id: "reference_images", label: "Reference images", kind: "image", multiple: true, required: true, accept: "b64_only" }],
    },
};

/** Get edit variant for an image model (if it has one) */
export function getEditVariant(caps: ImageModelCapability): EditVariant | undefined {
    return caps.has_edit_variant ? EDIT_VARIANTS[caps.id] : undefined;
}

/** Check if image model has required media slots */
export function hasRequiredSlots(caps: ImageModelCapability): boolean {
    return caps.media_slots.some(s => s.required);
}

/**
 * Normalizes every supported image-format declaration to [value, label] for
 * the command bar. Provider catalogs use the canonical aspect_ratio field,
 * while legacy Freepik models use size_ui or a custom field.
 */
export function getImageAspectRatios(caps: ImageModelCapability): [string, string][] {
    if (caps.size_ui) {
        return caps.size_ui.aspect_ratios.map(({ w, h }) => [`${w}:${h}`, `${w}:${h}`]);
    }

    const field = caps.custom_fields?.find(item => item.id === "aspect_ratio" && item.type === "select");
    if (field?.options?.length) {
        return field.options.map(option => {
            const match = option.match(/_(\.?\d+)_(\d+)$/);
            const value = match ? `${match[1]}:${match[2]}` : option;
            return [value, match ? value : option.replace(/_/g, " ")];
        });
    }

    return caps.aspect_ratio !== false
        ? (caps.aspect_ratio.options?.map(([label, value]) => [value, label]) ?? [])
        : [];
}
