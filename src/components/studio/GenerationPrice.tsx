"use client";
import { useState } from "react";
import useSWR from "swr";
import { CircleDollarSign, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { PriceQuote, PriceSelection } from "@/billing/types";
import { usd } from "@/billing/usage";

async function fetchPrice(url: string): Promise<PriceQuote> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo consultar el precio. Revisa la conexión o reintenta.");
    return response.json();
}
export function GenerationPrice({ model, resolution, aspectRatio, quality, size, count = 1 }: { model: ModelCapabilities; resolution?: string; aspectRatio?: string; quality?: string; size?: string; count?: number }) {
    const [open, setOpen] = useState(false), [manual, setManual] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
    const selection: PriceSelection = { provider: model.provider ?? "freepik", connectionId: model.provider_connection_id, model: model.provider_model_id ?? model.id, resolution, aspectRatio, quality, size };
    const query = new URLSearchParams(Object.entries(selection).filter(([, v]) => v !== undefined && v !== ""));
    const { data: quote, error, isLoading, mutate } = useSWR(`/api/billing/price?${query}`, fetchPrice, { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false });
    const n = Number.isInteger(count) && count > 0 && count <= 10 ? count : 1;
    const price = quote?.minUsd === undefined ? "Precio no disponible" : `${usd(quote.minUsd)}${quote.maxUsd !== quote.minUsd ? ` – ${usd(quote.maxUsd)}` : ""} / imagen`;
    async function save(value: number | null) {
        if (value !== null && (!Number.isFinite(value) || value < 0 || value > 10000 || !manual.trim())) { setMessage("Introduce una tarifa válida entre 0 y 10000 USD."); return; }
        setBusy(true); setMessage("");
        try {
            const response = await fetch("/api/billing/price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selection, usd: value }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "No se pudo guardar.");
            await mutate(result, false); setMessage(value === null ? "Tarifa manual retirada." : "Estimación guardada para esta configuración.");
        } catch (e) { setMessage(e instanceof Error ? e.message : "No se pudo guardar."); }
        finally { setBusy(false); }
    }
    return <>
        <button type="button" onClick={() => { setMessage(""); setManual(quote?.source === "manual" ? String(quote.minUsd) : ""); setOpen(true); }} className="mt-2 flex max-w-full items-start gap-1.5 text-left text-[11px] leading-relaxed text-[#c8d6a6] hover:text-[#d5ff47]" aria-label="Ver precio de generación">
            {isLoading ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : <CircleDollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{isLoading ? "Consultando precio…" : error ? "Precio no disponible · Reintentar" : `${quote?.source === "manual" ? "Manual" : "Salida estimada"}: ${price}`} · Detalles</span>
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto border border-white/15 bg-[#11140e] p-6 text-white sm:max-w-lg">
                <DialogTitle>Coste de generación</DialogTitle>
                <DialogDescription className="break-words text-white/60">{model.group} · {model.label}<br />{[resolution, aspectRatio, quality, size].filter(Boolean).join(" · ") || "Configuración predeterminada"}</DialogDescription>
                <div className="rounded-xl border border-[#d5ff47]/20 bg-[#d5ff47]/5 p-4"><p className="text-xl font-semibold text-[#d5ff47]">{price}</p>{n > 1 && quote?.minUsd !== undefined && <p className="mt-1 text-sm">{n} imágenes: {usd(quote.minUsd * n)} – {usd(quote.maxUsd! * n)}</p>}<p className="mt-2 text-xs leading-relaxed text-white/65">{quote?.note || "La tarifa no pudo consultarse. Esto no significa que generar sea gratis."}</p>{quote?.outputTokens !== undefined && <p className="mt-2 text-xs text-white/60">{quote.outputTokens.toLocaleString()} tokens de imagen estimados por salida; no son tokens consumidos todavía.</p>}</div>
                {!!quote?.rates?.length && <div className="space-y-2 text-xs">{quote.rates.map(rate => <div className="flex justify-between gap-3" key={`${rate.billable}:${rate.unit}`}><span>{rate.billable.startsWith("input") ? "Entrada" : "Salida"} · {rate.billable}</span><span>{usd(rate.minUsd * (rate.unit === "token" ? 1_000_000 : 1))}{rate.minUsd !== rate.maxUsd ? ` – ${usd(rate.maxUsd * (rate.unit === "token" ? 1_000_000 : 1))}` : ""} / {rate.unit === "token" ? "1 M tokens" : rate.unit}</span></div>)}</div>}
                {quote?.source === "openrouter" && <p className="text-xs text-white/50">Tarifas consultadas: {new Date(quote.checkedAt).toLocaleString()}. <a className="underline" href="https://openrouter.ai/docs/guides/overview/multimodal/image-generation" target="_blank" rel="noreferrer">Fuente: OpenRouter</a>{quote.outputTokens !== undefined && <> · <a className="underline" href="https://ai.google.dev/gemini-api/docs/image-generation" target="_blank" rel="noreferrer">Tokens de imagen: Google</a></>}</p>}
                <details className="border-t border-white/10 pt-3"><summary className="cursor-pointer text-sm">Configurar tarifa manual</summary><p className="my-3 text-xs leading-relaxed text-white/55">Útil para Higgsfield, API.market o un precio acordado. Solo se aplica a esta conexión, modelo y ajustes; no cambia la facturación del proveedor ni el gasto confirmado.</p><label className="text-xs">USD por imagen<input type="number" min="0" max="10000" step="any" value={manual} onChange={e => setManual(e.target.value)} placeholder="Ej.: 0.04" className="my-2 block w-full rounded-lg border border-white/20 bg-black/30 p-2 text-white" /></label><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void save(Number(manual))} className="rounded-lg bg-[#d5ff47] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Guardar estimación</button>{quote?.source === "manual" && <button type="button" disabled={busy} onClick={() => void save(null)} className="rounded-lg border border-white/20 px-3 py-2 text-xs">Volver a tarifa automática</button>}</div></details>
                {error && <button type="button" onClick={() => void mutate()} className="text-sm underline">Reintentar consulta</button>}
                {message && <p role="status" className="text-sm text-[#d5ff47]">{message}</p>}
            </DialogContent>
        </Dialog>
    </>;
}
