"use client";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { UsageGroup, UsageSummary } from "@/billing/types";
import { usd } from "@/billing/usage";

async function fetchSummary(url: string): Promise<UsageSummary> {
    const response = await fetch(url, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo consultar el consumo.");
    return result;
}
const number = (value: number | null | undefined) => value == null ? "No informado" : value.toLocaleString();
function sum(groups: UsageGroup[], key: "costUsd" | "totalTokens" | "estimateMin" | "estimateMax") {
    const values = groups.map(g => g[key]).filter(v => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
}
export function UsagePanel({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
    const { data, error, isLoading, mutate } = useSWR(open ? "/api/billing" : null, fetchSummary, { refreshInterval: 10_000, revalidateOnFocus: false, shouldRetryOnError: false });
    const external = useSWR(open ? "/api/billing?accounts=1" : null, fetchSummary, { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false });
    const groups = data?.groups ?? [];
    const keys = [...new Set([...(data?.connections ?? []).map(c => `${c.provider}|${c.id}`), ...groups.map(g => `${g.provider}|${g.connection}`)])];
    const requests = groups.reduce((n, g) => n + g.requests, 0), known = groups.reduce((n, g) => n + g.costKnown, 0);
    const name = (id: string) => data?.connections.find(c => c.id === id)?.name ?? (id === "environment" ? "Variables de entorno / conexión anterior" : `Conexión anterior (${id.slice(0, 8)})`);
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[88dvh] overflow-y-auto border border-white/15 bg-[#0f120d] p-5 text-white sm:max-w-4xl sm:p-7">
        <div className="pr-7"><DialogTitle className="text-2xl font-semibold">Consumo de APIs</DialogTitle><DialogDescription className="mt-2 text-white/55">Tokens y dólares · Studio y Workflows · Todo el registro local</DialogDescription></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Metric title="USD confirmados" value={usd(sum(groups, "costUsd"))} note={`${known} de ${requests} solicitudes con coste informado`} /><Metric title="Tokens informados" value={number(sum(groups, "totalTokens"))} note="Solo conteos reales; sin convertir imágenes o créditos" /><Metric title="Solicitudes registradas" value={number(requests)} note="Incluye pendientes y resultados inciertos" /></div>
        <p className="text-xs leading-relaxed text-white/55">El registro comienza con esta actualización y se conserva aunque borres imágenes. Las generaciones antiguas no tenían datos de coste/tokens. Los valores parciales no representan toda la factura; “No informado” no significa gratis.</p>
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Por API y conexión</h3><button type="button" disabled={isLoading || external.isValidating} onClick={() => { void mutate(); void external.mutate(); }} className="flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${isLoading || external.isValidating ? "animate-spin" : ""}`} />Actualizar</button></div>
        {error && <p role="alert" className="text-sm text-red-300">{error.message}</p>}
        {isLoading && <p role="status" className="text-sm text-white/60">Cargando consumo…</p>}
        {keys.map(key => {
            const [provider, connection] = key.split("|"), rows = groups.filter(g => g.provider === provider && g.connection === connection);
            const account = external.data?.accounts?.find(a => a.connection === connection);
            return <section key={key} className="rounded-2xl border border-white/10 bg-white/[.025] p-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><div><h4 className="font-semibold">{name(connection)}</h4><p className="text-xs text-white/45">{provider}</p></div><p className="text-sm text-[#d5ff47]">{usd(sum(rows, "costUsd"))} <span className="text-xs text-white/50">local confirmado</span></p></div>
                <p className="my-3 text-xs text-white/60">{number(sum(rows, "totalTokens"))} tokens · {rows.reduce((n, g) => n + g.costKnown, 0)}/{rows.reduce((n, g) => n + g.requests, 0)} solicitudes con USD informado</p>
                {!!rows.length && <div className="overflow-x-auto"><table className="w-full min-w-[530px] text-left text-xs"><thead className="text-white/45"><tr><th className="py-2 font-normal">Modelo</th><th className="p-2 font-normal">Tokens entrada / salida</th><th className="p-2 font-normal">USD confirmados</th><th className="p-2 font-normal">Estimado sin confirmar</th></tr></thead><tbody>{rows.map(row => <tr className="border-t border-white/5" key={row.model}><td className="max-w-[220px] break-words py-2 pr-3">{row.label}<small className="block text-white/40">{row.requests} solicitudes</small></td><td className="p-2">{number(row.inputTokens)} / {number(row.outputTokens)}</td><td className="p-2">{usd(row.costUsd)}<small className="block text-white/40">{row.costKnown}/{row.requests} informadas</small></td><td className="p-2">{row.estimateMin == null ? "—" : `${usd(row.estimateMin)} – ${usd(row.estimateMax)}`}<small className="block text-white/40">{row.estimated} completadas · no sumado</small></td></tr>)}</tbody></table></div>}
                {!rows.length && <p className="text-xs text-white/40">Todavía no hay generaciones registradas para esta conexión.</p>}
                <div className="mt-3 rounded-xl bg-black/25 p-3 text-xs"><p className="font-medium text-white/70">Acumulado externo del proveedor</p>{account?.status === "ok" && <p className="my-2 text-[#d5ff47]">Total: {usd(account.totalUsd)} · Mes: {usd(account.monthUsd)} · Hoy: {usd(account.todayUsd)}</p>}<p className="mt-1 leading-relaxed text-white/45">{account?.note ?? (external.error ? "No se pudo consultar. Prueba Actualizar en unos segundos." : external.isLoading ? "Consultando…" : "No disponible para esta conexión.")}</p></div>
            </section>;
        })}
        {data && !keys.length && <p className="text-sm text-white/50">Conecta una API para empezar a registrar consumo.</p>}
        {!!data?.recent.length && <details className="border-t border-white/10 pt-3"><summary className="cursor-pointer text-sm">Últimas 50 solicitudes · coste por generación</summary><div className="mt-3 space-y-2">{data.recent.map(row => <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-white/[.025] p-3 text-xs" key={row.id}><div>{row.label}<p className="mt-1 text-white/40">{new Date(row.created).toLocaleString()} · {row.source} · {row.status}</p></div><div className="text-right">{usd(row.costUsd)}<p className="mt-1 text-white/50">{number(row.totalTokens)} tokens</p></div></div>)}</div></details>}
    </DialogContent></Dialog>;
}
function Metric({ title, value, note }: { title: string; value: string; note: string }) {
    return <div className="rounded-xl border border-[#d5ff47]/15 bg-[#d5ff47]/5 p-4"><p className="text-xs text-white/60">{title}</p><p className="my-1 text-xl font-semibold text-[#d5ff47]">{value}</p><p className="text-[11px] leading-relaxed text-white/40">{note}</p></div>;
}
