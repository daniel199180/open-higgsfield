import "server-only";
import { getConnectionForProvider, getStoredConnections, type ProviderConnection } from "@/lib/connection-store";
import { providerFetch } from "@/providers/secure-fetch";
import { nonNegative } from "./usage";
import type { AccountUsage } from "./types";

export async function billingConnections() {
    const stored = await getStoredConnections();
    for (const provider of ["openrouter", "higgsfield", "api-market"] as const) {
        const fallback = await getConnectionForProvider(provider);
        if (fallback && !stored.some(c => c.id === fallback.id)) stored.push(fallback);
    }
    return stored;
}
async function account(connection: ProviderConnection): Promise<AccountUsage> {
    const base = { connection: connection.id, name: connection.name, provider: connection.provider };
    if (!connection.enabled) return { ...base, status: "unavailable", note: "Conexión desactivada." };
    if (connection.provider !== "openrouter") return { ...base, status: "unavailable", note: connection.provider === "api-market"
        ? "API.market informa llamadas/cuotas, no un importe USD ni tokens uniformes. Consulta la factura del producto; las tarifas manuales son estimaciones."
        : "El adaptador no dispone de un endpoint de facturación verificado. Consulta el panel de la API; los créditos web no equivalen a USD de la API." };
    try {
        const response = await providerFetch("openrouter", "https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${connection.credentials.apiKey}` }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("unavailable");
        const { data } = await response.json();
        if (!data || typeof data !== "object") throw new Error("unavailable");
        // Whitelist: never send the label, hash, user IDs, key or complete upstream response.
        return { ...base, status: "ok", totalUsd: nonNegative(data.usage), monthUsd: nonNegative(data.usage_monthly), todayUsd: nonNegative(data.usage_daily), note: "Acumulado informado por esta clave, incluido uso fuera de la plataforma. No se suma al registro local. BYOK no incluido. Si reutilizas una clave en varias conexiones, el mismo acumulado puede aparecer repetido." };
    } catch { return { ...base, status: "error", note: "No se pudo consultar el gasto de esta clave. El registro local sigue disponible." }; }
}
export async function accountUsage(connections: ProviderConnection[]) {
    // Bound concurrency; credentials never leave the server except to the fixed provider endpoint.
    const results: AccountUsage[] = [];
    for (let index = 0; index < connections.length; index += 4) results.push(...await Promise.all(connections.slice(index, index + 4).map(account)));
    return results;
}
