import "server-only";

export const PROVIDER_BASES = {
    openrouter: "https://openrouter.ai/api/v1",
    higgsfield: "https://api.higgsfield.ai",
    "api-market": "https://prod.api.market/api/mcp",
} as const;
export type ConfigurableProvider = keyof typeof PROVIDER_BASES;

export function providerBase(provider: ConfigurableProvider, configured?: string) {
    const base = PROVIDER_BASES[provider];
    if (configured && configured.replace(/\/$/, "") !== base) throw new Error("ERR_PROVIDER_URL_NOT_ALLOWED");
    return base;
}
export function providerUrl(provider: ConfigurableProvider, value: string): URL {
    const base = new URL(PROVIDER_BASES[provider]);
    const url = new URL(value, `${base}/`);
    if (url.origin !== base.origin || url.username || url.password || url.hash ||
        (base.pathname !== "/" && url.pathname !== base.pathname && !url.pathname.startsWith(`${base.pathname}/`))) {
        throw new Error("ERR_PROVIDER_URL_NOT_ALLOWED");
    }
    return url;
}
export async function providerFetch(provider: ConfigurableProvider, value: string, init: RequestInit = {}) {
    return fetch(providerUrl(provider, value), {
        ...init, redirect: "error", cache: "no-store",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
}
