"use client";
import { useEffect, useMemo, useState } from "react";
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { PriceQuote } from "@/billing/types";
import { usd } from "@/billing/usage";
import { executionGraph } from "@/workflows/validation";
import type { WorkflowGraph } from "@/workflows/types";
import { angleFormats } from "@/workflows/sales-angles";

type CostSelection = { model?: ModelCapabilities; resolution?: string; aspectRatio?: string; size?: string };
export function WorkflowRunCost({ graph, models, targetId }: { graph: WorkflowGraph; models: ModelCapabilities[]; targetId?: string }) {
    const selections = useMemo<CostSelection[]>(() => {
        const selected = executionGraph(graph, targetId);
        return selected.nodes.flatMap(node => {
            if (node.kind === "salesAngles") return (node.config.angles ?? []).flatMap(angle => angleFormats(angle).map(format => ({ model: models.find(item => item.id === angle.modelId), resolution: angle.resolution, aspectRatio: format.formatField === "aspect_ratio" ? format.format : undefined, size: format.formatField === "size" ? format.format : undefined })));
            if (node.kind === "image") return [{ model: models.find(item => item.id === node.config.modelId), resolution: String(node.config.params?.resolution ?? ""), aspectRatio: String(node.config.params?.aspect_ratio ?? ""), size: String(node.config.params?.size ?? "") }];
            if (node.kind === "video" || node.kind === "audio") return [{ model: undefined }];
            return [];
        });
    }, [graph, models, targetId]);
    const [summary, setSummary] = useState<{ known: number; min: number; max: number; loading: boolean }>({ known: 0, min: 0, max: 0, loading: true });
    useEffect(() => {
        let cancelled = false;
        const urls = selections.map(({ model, resolution, aspectRatio, size }) => {
            if (!model) return "";
            const query = new URLSearchParams({ provider: model.provider ?? "freepik", model: model.provider_model_id ?? model.id });
            if (model.provider_connection_id) query.set("connectionId", model.provider_connection_id);
            if (resolution) query.set("resolution", resolution);
            if (aspectRatio) query.set("aspectRatio", aspectRatio);
            if (size) query.set("size", size);
            return `/api/billing/price?${query}`;
        });
        void (async () => {
            const unique = [...new Set(urls.filter(Boolean))];
            const quotes = new Map(await Promise.all(unique.map(async url => {
                try {
                    const response = await fetch(url, { cache: "no-store" });
                    return [url, response.ok ? await response.json() as PriceQuote : null] as const;
                } catch { return [url, null] as const; }
            })));
            if (!cancelled) setSummary(urls.reduce((total, url) => {
                const quote = quotes.get(url);
                if (quote?.minUsd !== undefined) {
                    total.known++;
                    total.min += quote.minUsd;
                    total.max += quote.maxUsd ?? quote.minUsd;
                }
                return total;
            }, { known: 0, min: 0, max: 0, loading: false }));
        })();
        return () => { cancelled = true; };
    }, [selections]);
    return <p className="wf-muted" role="status">{summary.loading ? "Consultando precios…" : summary.known ? `Estimación ${summary.known === selections.length ? "total" : `parcial (${summary.known}/${selections.length})`}: ${usd(summary.min)}${summary.max !== summary.min ? ` – ${usd(summary.max)}` : ""}. No incluye cargos no publicados ni garantiza el cobro final.` : "Precio no disponible para las solicitudes seleccionadas; esto no significa que sean gratuitas."}</p>;
}
