import type { BrandSystem } from "@/social/types";
import { brandIdentityPrompt } from "@/social/brand";
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { SalesAngle, AngleFormat } from "./types";

export const angleKey = (nodeId: string, angleId: string) => `${nodeId}:${angleId}`;
export const angleFormatKey = ({ formatField, format }: AngleFormat) => `${formatField}:${format}`;
export const angleFormats = (angle: SalesAngle): AngleFormat[] => [
    { formatField: angle.formatField, format: angle.format },
    ...(angle.additionalFormats ?? []),
];
export const angleGenerationCount = (angle: SalesAngle) => angleFormats(angle).length;
export const rasterAngleModel = (cap: ModelCapabilities) => !cap.media_slots.some(slot => slot.required) && !/vector/i.test(`${cap.provider_model_id ?? cap.id} ${cap.label}`) && angleFormatOptions(cap).length > 0;

export function angleFormatOptions(cap: ModelCapabilities): Array<{ field: "aspect_ratio" | "size"; value: string; label: string }> {
    const ratios = cap.aspect_ratio && cap.aspect_ratio.options?.map(([label, value]) => ({ field: "aspect_ratio" as const, value, label })) || [];
    const custom = cap.custom_fields.find(field => field.id === "aspect_ratio" && field.type === "select")?.options?.map(value => ({ field: "aspect_ratio" as const, value, label: value })) || [];
    const sizes = cap.size && cap.size.options?.map(([label, value]) => ({ field: "size" as const, value, label })) || [];
    return [...ratios, ...custom, ...sizes].filter((option, index, options) => option.value.toLowerCase() !== "auto" && options.findIndex(other => other.field === option.field && other.value === option.value) === index);
}

export function anglePrompt(brief: string, angle: SalesAngle, brand?: BrandSystem): string {
    return [
        brief.trim(),
        `Ángulo de venta: ${angle.text.trim()}. Crea una pieza visual publicitaria que comunique específicamente este ángulo. Conserva el idioma y el texto solicitados. Adapta la composición al formato elegido, con márgenes seguros y sin cortar textos, producto o logo.`,
        brand ? brandIdentityPrompt(brand) : "",
    ].filter(Boolean).join("\n\n");
}
