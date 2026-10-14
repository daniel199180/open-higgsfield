export interface ApiMarketProduct {
    workspace: string;
    slug: string;
    mediaType: "image" | "video" | "both";
}

const workspacePattern = /^[a-zA-Z0-9_-]{1,100}$/;
const slugPattern = /^[a-zA-Z0-9_-]{1,150}$/;

export function parseApiMarketProducts(value: string): ApiMarketProduct[] {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error("ERR_API_MARKET_PRODUCTS_INVALID"); }
    if (!Array.isArray(parsed) || parsed.length > 30) throw new Error("ERR_API_MARKET_PRODUCTS_INVALID");
    const seen = new Set<string>();
    return parsed.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ERR_API_MARKET_PRODUCTS_INVALID");
        const row = entry as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "mediaType,slug,workspace" ||
            typeof row.workspace !== "string" || !workspacePattern.test(row.workspace) ||
            typeof row.slug !== "string" || !slugPattern.test(row.slug) ||
            !["image", "video", "both"].includes(String(row.mediaType))) throw new Error("ERR_API_MARKET_PRODUCTS_INVALID");
        const id = `${row.workspace}/${row.slug}`.toLowerCase();
        if (seen.has(id)) throw new Error("ERR_API_MARKET_PRODUCTS_INVALID");
        seen.add(id);
        return { workspace: row.workspace, slug: row.slug, mediaType: row.mediaType as ApiMarketProduct["mediaType"] };
    });
}

export function apiMarketProductConnectionId(accountId: string, product: ApiMarketProduct): string {
    return `${accountId}:${product.workspace}:${product.slug}`;
}

export function subscribedApiMarketProducts(payload: unknown): ApiMarketProduct[] {
    const list = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { usageData?: unknown }).usageData : null;
    if (!Array.isArray(list)) throw new Error("ERR_API_MARKET_CATALOG_INVALID");
    const products: ApiMarketProduct[] = [];
    const seen = new Set<string>();
    for (const item of list.slice(0, 500)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        const parts = typeof row.apiName === "string" ? row.apiName.split("/") : [];
        const workspace = typeof row.store === "string" ? row.store : parts.length === 2 ? parts[0] : "";
        const slug = typeof row.apiProduct === "string" ? row.apiProduct : parts.length === 2 ? parts[1] : "";
        if (!workspacePattern.test(workspace) || !slugPattern.test(slug)) continue;
        const id = `${workspace}/${slug}`.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        products.push({ workspace, slug, mediaType: /video|motion|seedance|kling|wan-/i.test(slug) ? "video" : "image" });
    }
    return products;
}
