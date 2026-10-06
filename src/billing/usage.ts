import type { GenerationUsage, PriceSelection } from "./types";

/** A billed response may still contain an unusable asset. Preserve its sanitized usage. */
export class UsageReportedError extends Error {
    constructor(code: string, readonly usage?: GenerationUsage) { super(code); }
}

export function nonNegative(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function tokens(value: unknown) {
    const n = nonNegative(value);
    return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}
export function openRouterUsage(value: unknown): GenerationUsage | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const raw = value as Record<string, unknown>;
    const inputTokens = tokens(raw.prompt_tokens), outputTokens = tokens(raw.completion_tokens);
    const totalTokens = tokens(raw.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? tokens(inputTokens + outputTokens) : undefined);
    const usage = { inputTokens, outputTokens, totalTokens, costUsd: nonNegative(raw.cost) };
    return Object.values(usage).some(v => v !== undefined) ? usage : undefined;
}
/** A manual rate belongs only to this API, model and exact output settings. */
export function priceKey(selection: PriceSelection): string {
    return JSON.stringify([selection.provider, selection.connectionId || "default", selection.model, selection.resolution || "", selection.quality || "", selection.aspectRatio || "", selection.size || ""]);
}
export function usd(value: number | null | undefined): string {
    return value == null ? "No informado" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}
