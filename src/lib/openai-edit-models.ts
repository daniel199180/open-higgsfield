/** Retained for the optional direct OpenAI provider; the image editor uses OpenRouter. */
export const OPENAI_EDIT_MODELS = [
    { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
    { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
] as const;

export const DEFAULT_OPENAI_EDIT_MODEL = "gpt-image-2.5-sunburst";

export function isOpenAIEditModel(value: string): value is (typeof OPENAI_EDIT_MODELS)[number]["id"] {
    return OPENAI_EDIT_MODELS.some((model) => model.id === value);
}
