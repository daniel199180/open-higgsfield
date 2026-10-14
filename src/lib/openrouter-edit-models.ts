export const OPENROUTER_EDIT_MODELS = [
    { id: "openai/gpt-image-2.5-sunburst", label: "OpenRouter · GPT Image 2.5 Sunburst · precisión" },
    { id: "openai/gpt-image-2.5-flare", label: "OpenRouter · GPT Image 2.5 Flare · rápido" },
] as const;

export type OpenRouterEditModel = (typeof OPENROUTER_EDIT_MODELS)[number]["id"];
export const DEFAULT_OPENROUTER_EDIT_MODEL: OpenRouterEditModel = "openai/gpt-image-2.5-sunburst";

export function isOpenRouterEditModel(value: string): value is OpenRouterEditModel {
    return OPENROUTER_EDIT_MODELS.some((model) => model.id === value);
}

type CatalogRow = {
    id?: unknown;
    architecture?: { input_modalities?: unknown; output_modalities?: unknown };
    supported_parameters?: Record<string, unknown>;
};

function values(descriptor: unknown): string[] {
    if (!descriptor || typeof descriptor !== "object" || !Array.isArray((descriptor as { values?: unknown }).values)) return [];
    return (descriptor as { values: unknown[] }).values.filter((value): value is string => typeof value === "string");
}

/** Only expose models that currently accept source images on OpenRouter's Images API. */
export function availableOpenRouterEditModels(rows: unknown): Array<(typeof OPENROUTER_EDIT_MODELS)[number]> {
    if (!Array.isArray(rows)) return [];
    return OPENROUTER_EDIT_MODELS.filter((candidate) => rows.some((item: CatalogRow) => {
        if (!item || item.id !== candidate.id) return false;
        const input = item.architecture?.input_modalities;
        const output = item.architecture?.output_modalities;
        const refs = item.supported_parameters?.input_references as { max?: unknown } | undefined;
        return Array.isArray(input) && input.includes("image") && Array.isArray(output) && output.includes("image")
            && typeof refs?.max === "number" && refs.max >= 1
            && values(item.supported_parameters?.quality).includes("high")
            && values(item.supported_parameters?.aspect_ratio).includes("auto");
    }));
}

export function supportsOpenRouterEditOptions(row: CatalogRow | undefined, quality: string, aspectRatio: string, references: number): boolean {
    const supported = row?.supported_parameters;
    const refs = supported?.input_references as { max?: unknown } | undefined;
    return typeof refs?.max === "number" && refs.max >= references
        && values(supported?.quality).includes(quality)
        && values(supported?.aspect_ratio).includes(aspectRatio);
}

export function supportedOpenRouterEditRatios(row: CatalogRow | undefined): string[] {
    return values(row?.supported_parameters?.aspect_ratio);
}
