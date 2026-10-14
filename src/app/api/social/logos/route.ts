import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildLogoPrompt, logoCommand } from "@/social/logo-request";
import { authorizeRequest, limitRequest, readJsonBody, securityError } from "@/lib/api-security";
import { billingStore } from "@/billing/store";
import { openRouterUsage } from "@/billing/usage";
import { getConnectionForProvider, type ProviderConnection } from "@/lib/connection-store";
import { openRouterFailure } from "@/providers/openrouter-errors";
import { providerFetch } from "@/providers/secure-fetch";
import { sanitizeVectorSvg, previewVector, traceLogoImage } from "@/social/vector";
import type { BrandSystem, LogoResult } from "@/social/types";
import { readAsset, saveAsset, saveVectorAsset } from "@/workflows/assets";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { requireCompany } from "@/library/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VectorModel = { id: string; name: string; acceptsImage: boolean; maxOutputs: number };
function baseUrl(connection: ProviderConnection) { return (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, ""); }

function headers(connection: ProviderConnection): Record<string, string> {
    const value: Record<string, string> = { Authorization: `Bearer ${connection.credentials.apiKey}` };
    if (connection.config.httpReferer) value["HTTP-Referer"] = connection.config.httpReferer;
    if (connection.config.appTitle) value["X-OpenRouter-Title"] = connection.config.appTitle;
    return value;
}

async function vectorModels(connection: ProviderConnection): Promise<VectorModel[]> {
    const response = await providerFetch("openrouter", `${baseUrl(connection)}/images/models`, { headers: headers(connection), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new WorkflowError("No se pudo consultar el catálogo vectorial de OpenRouter.", 502);
    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    return (payload.data ?? []).flatMap(raw => {
        const id = typeof raw.id === "string" ? raw.id : "";
        const supported = raw.supported_parameters as Record<string, unknown> | undefined;
        const outputFormat = supported?.output_format as { values?: unknown[] } | undefined;
        if (!id || !Array.isArray(outputFormat?.values) || !outputFormat.values.includes("svg")) return [];
        const inputs = (raw.architecture as { input_modalities?: unknown[] } | undefined)?.input_modalities;
        const n = supported?.n as { max?: number } | undefined;
        return [{ id, name: typeof raw.name === "string" ? raw.name : id, acceptsImage: Array.isArray(inputs) && inputs.includes("image"), maxOutputs: typeof n?.max === "number" ? Math.min(4, n.max) : 1 }];
    }).slice(0, 30);
}

async function persistLogo(brandId: string | undefined, companyId: string | undefined, mode: LogoResult["mode"], prompt: string, svg: Buffer, modelId?: string, sourceAssetId?: string): Promise<LogoResult> {
    const safe = sanitizeVectorSvg(svg.toString("utf8"));
    const png = await previewVector(safe);
    const preview = await saveAsset(png, "image");
    const vector = await saveVectorAsset(safe);
    const result: LogoResult = { id: crypto.randomUUID(), ...(brandId ? { brandId } : {}), companyId, mode, prompt, modelId, sourceAssetId, vectorAssetId: vector.id, previewAssetId: preview.id, createdAt: Date.now() };
    await workflowStore().transaction(docs => { docs.set(`logo:${result.id}`, result); });
    return result;
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const store = workflowStore();
    const results = (await store.list<LogoResult>("logo:")).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    try {
        const connection = await getConnectionForProvider("openrouter");
        if (!connection?.credentials.apiKey) return NextResponse.json({ results, models: [], message: "Conecta OpenRouter para crear logos con IA. La vectorización local funciona sin API." }, { headers: { "Cache-Control": "no-store" } });
        return NextResponse.json({ results, models: await vectorModels(connection) }, { headers: { "Cache-Control": "no-store" } });
    } catch {
        return NextResponse.json({ results, models: [], message: "No se pudo consultar el catálogo de OpenRouter. Puedes vectorizar imágenes localmente." }, { headers: { "Cache-Control": "no-store" } });
    }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("social-logo", 8, 60_000); if (limited) return limited;
    try {
        const input = logoCommand.parse(await readJsonBody(req));
        await requireCompany(input.companyId);
        const store = workflowStore();
        const brand = input.brandId ? await store.read<BrandSystem>(`brand:${input.brandId}`) : undefined;
        if (input.brandId && !brand) throw new WorkflowError("El sistema de diseño seleccionado ya no existe.", 404);
        if (input.mode === "trace") {
            const source = await readAsset(input.sourceAssetId);
            if (source.asset.kind !== "image") throw new WorkflowError("Selecciona una imagen raster válida.");
            const svg = await traceLogoImage(source.data, input.colors);
            const result = await persistLogo(brand?.id, input.companyId, "trace", "Vectorización fiel de imagen", svg, undefined, input.sourceAssetId);
            return NextResponse.json({ results: [result] }, { status: 201 });
        }
        const connection = await getConnectionForProvider("openrouter");
        if (!connection?.credentials.apiKey) throw new WorkflowError("Conecta OpenRouter en Conexiones de APIs.", 400);
        const model = (await vectorModels(connection)).find(item => item.id === input.modelId);
        if (!model) throw new WorkflowError("Este modelo no anuncia salida SVG en OpenRouter.");
        if (input.count > model.maxOutputs) throw new WorkflowError(`Este modelo permite hasta ${model.maxOutputs} resultado(s) por solicitud.`);
        if (input.mode === "redraw" && (!model.acceptsImage || !input.sourceAssetId)) throw new WorkflowError("Selecciona una imagen y un modelo que acepte referencias.");
        let reference: string | undefined;
        if (input.mode === "redraw") {
            const source = await readAsset(input.sourceAssetId!);
            if (source.asset.kind !== "image") throw new WorkflowError("La referencia debe ser una imagen raster.");
            reference = `data:${source.asset.mime};base64,${source.data.toString("base64")}`;
        }
        const prompt = buildLogoPrompt(input, brand);
        const requestId = `logo:${crypto.randomUUID()}`;
        await billingStore().begin({ id: requestId, provider: "openrouter", connection: connection.id, model: model.id, label: model.name, media: "image", source: "studio", created: new Date().toISOString(), status: "RUNNING" });
        let usage;
        try {
            const response = await providerFetch("openrouter", `${baseUrl(connection)}/images`, {
                method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" },
                body: JSON.stringify({ model: model.id, prompt, n: input.count, output_format: "svg", aspect_ratio: "1:1", ...(reference ? { input_references: [{ type: "image_url", image_url: { url: reference } }] } : {}) }),
            });
            const payload = await response.json().catch(() => null) as { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: unknown; error?: unknown } | null;
            usage = openRouterUsage(payload?.usage);
            if (!response.ok || payload?.error) throw new WorkflowError(`OpenRouter rechazó la solicitud (${openRouterFailure(response.status, payload).code}).`, 502);
            if (!Array.isArray(payload?.data) || payload.data.length !== input.count) throw new WorkflowError("OpenRouter no devolvió la cantidad de logos solicitada.", 502);
            const results: LogoResult[] = [];
            for (const item of payload.data) {
                if (item.media_type !== "image/svg+xml" || !item.b64_json) throw new WorkflowError("El modelo no devolvió un SVG nativo.", 502);
                results.push(await persistLogo(brand?.id, input.companyId, input.mode, input.prompt, Buffer.from(item.b64_json, "base64"), model.id, input.sourceAssetId));
            }
            await billingStore().update(requestId, "COMPLETED", usage);
            return NextResponse.json({ results }, { status: 201 });
        } catch (error) {
            await billingStore().update(requestId, "FAILED", usage);
            throw error;
        }
    } catch (error) {
        if (error instanceof WorkflowError) return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof z.ZodError) return NextResponse.json({ error: "Revisa los datos del logo." }, { status: 400 });
        return securityError(error);
    }
}
