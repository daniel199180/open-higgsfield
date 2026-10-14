import "server-only";
import { subscribedApiMarketProducts } from "@/lib/api-market-products";

const SUBSCRIPTIONS_URL = "https://prod.api.market/api/v1/user/usage/";

export async function apiMarketSubscriptions(apiKey: string) {
    let response: Response;
    try {
        response = await fetch(SUBSCRIPTIONS_URL, {
            method: "GET",
            headers: { "x-api-market-key": apiKey, Accept: "application/json" },
            cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
        });
    } catch { throw new Error("ERR_API_MARKET_SUBSCRIPTIONS_UNAVAILABLE"); }
    if (response.status === 401 || response.status === 403) throw new Error("ERR_API_MARKET_KEY_REJECTED");
    if (!response.ok) throw new Error("ERR_API_MARKET_SUBSCRIPTIONS_UNAVAILABLE");
    const payload: unknown = await response.json().catch(() => null);
    return subscribedApiMarketProducts(payload);
}
