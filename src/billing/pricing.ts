import "server-only";
import { providerFetch } from "@/providers/secure-fetch";
import { billingStore } from "./store";
import { nonNegative, priceKey } from "./usage";
import type { PriceQuote, PriceSelection } from "./types";

type Endpoint = { supported_parameters?: Record<string, { type?: string; values?: string[] }>; pricing?: { billable?: string; unit?: string; cost_usd?: number; variant?: string }[] };
const cache = new Map<string, { at: number; promise: Promise<Endpoint[]> }>();
function endpoints(model: string): Promise<Endpoint[]> {
    const previous = cache.get(model);
    if (previous && Date.now() - previous.at < 5 * 60_000) return previous.promise;
    // Encode each segment; never follow a provider-supplied URL or redirect.
    const promise = providerFetch("openrouter", `https://openrouter.ai/api/v1/images/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`, { signal: AbortSignal.timeout(8000) })
        .then(async response => {
            if (!response.ok) throw new Error("ERR_PRICE_UNAVAILABLE");
            const json = await response.json();
            if (!Array.isArray(json.endpoints)) throw new Error("ERR_PRICE_UNAVAILABLE");
            return json.endpoints.slice(0, 100) as Endpoint[];
        }).catch(error => { cache.delete(model); throw error; });
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(model, { at: Date.now(), promise });
    return promise;
}
export function unavailableQuote(note = "Este proveedor no publica una tarifa consultable por la aplicación. Puedes introducir una estimación manual en USD por imagen."): PriceQuote {
    return { source: "unavailable", note, checkedAt: new Date().toISOString() };
}
/** Output-only quote. It must not be presented as a guaranteed all-inclusive charge. */
export function quoteEndpoints(selection: PriceSelection, entries: Endpoint[]): PriceQuote {
    const checkedAt = new Date().toISOString();
    const resolution = selection.resolution?.toLowerCase();
    const quality = selection.quality?.toLowerCase();
    const sizes = selection.size?.match(/^(\d+)x(\d+)$/i);
    const megapixels = sizes ? Number(sizes[1]) * Number(sizes[2]) / 1_000_000 : undefined;
    // Google image token counts documented at ai.google.dev/gemini-api/docs/image-generation.
    // Counts are model-specific, not a universal tokens-per-image conversion.
    const outputTokens = sizes ? undefined
        : selection.model === "google/gemini-2.5-flash-image" && (!resolution || resolution === "1k") ? 1290
        : selection.model === "google/gemini-nano-banana-2.1" ? ({ "1k": 1120, "2k": 1680, "4k": 2520 }[resolution || "1k"])
        : ["google/gemini-3.1-flash-image", "google/gemini-3.1-flash-image-preview"].includes(selection.model)
            ? ({ "512": 747, "0.5k": 747, "1k": 1120, "2k": 1680, "4k": 2520 }[resolution || "1k"])
        : ["google/gemini-3-pro-image", "google/gemini-3-pro-image-preview"].includes(selection.model)
            ? ({ "1k": 1120, "2k": 1120, "4k": 2000 }[resolution || "1k"]) : undefined;
    const amounts: number[] = [];
    const rates = new Map<string, { billable: string; unit: string; minUsd: number; maxUsd: number }>();
    let unpriced = false;
    for (const endpoint of entries) {
        const params = endpoint.supported_parameters;
        if (Object.entries({ resolution: selection.resolution, quality: selection.quality, aspect_ratio: selection.aspectRatio }).some(([key, value]) => value && params?.[key]?.values && !params[key].values.some(v => v.toLowerCase() === value.toLowerCase()))) continue;
        const outputLines = (endpoint.pricing || []).filter(p => p.billable === "output_image");
        const matching = outputLines.filter(p => !p.variant || [resolution, quality].includes(p.variant.toLowerCase()));
        // An unresolved variant, compound meter or unknown token count cannot be guessed.
        if (matching.length !== 1) unpriced = true;
        for (const line of endpoint.pricing || []) {
            const cost = nonNegative(line.cost_usd);
            if (cost === undefined || !line.billable || !line.unit) continue;
            if (line.variant && ![resolution, quality].includes(line.variant.toLowerCase())) continue;
            const key = `${line.billable}:${line.unit}`;
            const rate = rates.get(key);
            rates.set(key, { billable: line.billable, unit: line.unit, minUsd: Math.min(rate?.minUsd ?? cost, cost), maxUsd: Math.max(rate?.maxUsd ?? cost, cost) });
        }
        if (matching.length === 1) {
            const line = matching[0], cost = nonNegative(line.cost_usd);
            const units = line.unit === "image" ? 1 : line.unit === "token" ? outputTokens : line.unit === "megapixel" ? megapixels : undefined;
            if (cost !== undefined && units !== undefined) amounts.push(cost * units);
            else unpriced = true;
        }
    }
    const known = amounts.length > 0 && !unpriced;
    return {
        source: "openrouter", checkedAt, rates: [...rates.values()],
        ...(known ? { minUsd: Math.min(...amounts), maxUsd: Math.max(...amounts), outputTokens } : {}),
        note: known ? "Estimación de salida por imagen; no incluye prompt, referencias ni otros cargos. La ruta del proveedor puede variar. El coste final se registra al generar."
            : "Precio final variable: depende de los tokens, dimensiones o ruta. Se muestran las tarifas publicadas; no hay un precio cerrado por imagen para esta selección.",
    };
}
export async function imageQuote(selection: PriceSelection): Promise<PriceQuote> {
    const manual = await billingStore().rate(priceKey(selection));
    if (manual !== undefined) return { source: "manual", minUsd: manual, maxUsd: manual, note: "Tarifa manual por imagen para esta API, modelo y configuración. Es una estimación, no un cargo confirmado por el proveedor.", checkedAt: new Date().toISOString() };
    if (selection.provider !== "openrouter") return unavailableQuote();
    try { return quoteEndpoints(selection, await endpoints(selection.model)); }
    catch { return unavailableQuote("No se pudo consultar la tarifa de OpenRouter. Reintenta o configura una estimación manual; esto no impide generar."); }
}
