export interface BackgroundRemovalModel {
    id: string;
    name: string;
}

const PREFERRED = [
    "openai/gpt-image-2.5-sunburst",
    "openai/gpt-image-2.5-flare",
    "openai/gpt-image-2",
    "openai/gpt-image-1.5",
    "openai/gpt-image-1",
];

function parameterValues(value: unknown): string[] {
    if (!value || typeof value !== "object") return [];
    const values = (value as { values?: unknown }).values;
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
}

/** Only advertise GPT Image endpoints that explicitly accept an image and transparent PNG output. */
export function backgroundRemovalModels(data: unknown): BackgroundRemovalModel[] {
    if (!Array.isArray(data)) return [];
    return data.flatMap((entry): BackgroundRemovalModel[] => {
        if (!entry || typeof entry !== "object") return [];
        const model = entry as Record<string, unknown>;
        const id = typeof model.id === "string" ? model.id : "";
        if (!/^openai\/gpt-image-(?:\d|\d\.\d)/.test(id)) return [];
        const inputs = (model.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
        if (!Array.isArray(inputs) || !inputs.includes("image")) return [];
        const parameters = model.supported_parameters as Record<string, unknown> | undefined;
        if (!parameterValues(parameters?.background).includes("transparent")) return [];
        const formats = parameterValues(parameters?.output_format);
        if (formats.length && !formats.includes("png")) return [];
        return [{ id, name: typeof model.name === "string" ? model.name : id }];
    }).sort((a, b) => {
        const left = PREFERRED.indexOf(a.id);
        const right = PREFERRED.indexOf(b.id);
        return (left < 0 ? PREFERRED.length : left) - (right < 0 ? PREFERRED.length : right) || a.name.localeCompare(b.name);
    });
}
