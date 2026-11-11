import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMcpServer, touchMcpServer, type McpServerConfig } from "@/lib/mcp-server-store";
import { bearerToken, imagePreviewContent, signedMediaUrl, taskBelongsToServer, taskMediaPaths } from "@/lib/mcp-runtime";
import { findCapability } from "@/providers/catalog";
import { submitGeneration } from "@/lib/generation-service";
import { getTask, initStore } from "@/lib/task-store";
import { assertSafeRemoteUrl } from "@/lib/safe-url";
import { limitRequest, readLimitedBody } from "@/lib/api-security";
import { publicErrorMessage } from "@/lib/public-error";
import type { CanonicalMediaInputs, CanonicalParams } from "@/models/canonical";
import type { ModelCapabilities } from "@/models/capabilities/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RpcId = string | number | null;
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown };

const generationSchema = z.object({
    model: z.string().min(1).max(500).optional(),
    prompt: z.string().trim().min(1).max(20000),
    negative_prompt: z.string().max(10000).optional(),
    aspect_ratio: z.string().max(30).optional(),
    resolution: z.string().max(30).optional(),
    duration: z.union([z.string(), z.number()]).optional(),
    seed: z.number().int().min(0).max(2147483647).optional(),
    input_image_url: z.string().url().max(2000).optional(),
    reference_image_urls: z.array(z.string().url().max(2000)).max(10).optional(),
    generate_audio: z.boolean().optional(),
    parameters: z.record(z.string().max(100), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();

function response(id: RpcId | undefined, result: unknown, status = 200) {
    return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result }, { status, headers: { "Cache-Control": "no-store" } });
}

function rpcError(id: RpcId | undefined, code: number, message: string, status = 200) {
    return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

function textResult(value: unknown, isError = false) {
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function modelDescription(capability: ModelCapabilities): string {
    return `${capability.label} (${capability.group})`;
}

async function generationTool(server: McpServerConfig, mediaType: "image" | "video") {
    const ids = mediaType === "image" ? server.imageModelIds : server.videoModelIds;
    const models = (await Promise.all(ids.map((id) => findCapability(mediaType, id)))).filter((item): item is ModelCapabilities => Boolean(item));
    const properties: Record<string, unknown> = {
        prompt: { type: "string", description: "Descripción de lo que se debe generar." },
        model: { type: "string", enum: models.map((model) => model.id), description: models.map((model) => `${model.id}: ${modelDescription(model)}`).join(" | ") },
        negative_prompt: { type: "string", description: "Elementos que deben evitarse." },
        aspect_ratio: { type: "string", description: "Relación de aspecto, por ejemplo 1:1, 16:9 o 9:16." },
        resolution: { type: "string", description: "Resolución admitida por el modelo." },
        seed: { type: "integer", minimum: 0 },
        input_image_url: { type: "string", format: "uri", description: "Imagen HTTPS de entrada o fotograma inicial." },
        reference_image_urls: { type: "array", maxItems: 10, items: { type: "string", format: "uri" } },
        parameters: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Parámetros avanzados admitidos por el proveedor." },
    };
    if (mediaType === "video") {
        properties.duration = { oneOf: [{ type: "string" }, { type: "number" }], description: "Duración en segundos." };
        properties.generate_audio = { type: "boolean", description: "Generar audio cuando el modelo lo admita." };
    }
    return {
        name: mediaType === "image" ? "generate_image" : "generate_video",
        description: `Crea ${mediaType === "image" ? "una imagen" : "un video"} con uno de los modelos autorizados en ${server.name}. Devuelve un task_id para consultar con get_generation.`,
        inputSchema: { type: "object", properties, required: models.length === 1 ? ["prompt"] : ["prompt", "model"], additionalProperties: false },
    };
}

async function listTools(server: McpServerConfig) {
    const tools: unknown[] = [];
    if (server.imageModelIds.length) tools.push(await generationTool(server, "image"));
    if (server.videoModelIds.length) tools.push(await generationTool(server, "video"));
    tools.push({
        name: "get_generation",
        description: "Consulta el estado y obtiene los archivos de una generación iniciada por este MCP.",
        inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    });
    return tools;
}

async function validateRemoteUrls(values: Array<string | undefined>) {
    for (const value of values) {
        if (!value) continue;
        const url = await assertSafeRemoteUrl(value);
        if (url.protocol !== "https:") throw new Error("Las referencias deben usar URLs HTTPS públicas.");
    }
}

async function submit(server: McpServerConfig, mediaType: "image" | "video", raw: unknown) {
    const parsed = generationSchema.safeParse(raw);
    if (!parsed.success) return textResult("Parámetros inválidos: revisa prompt, modelo y URLs.", true);
    const input = parsed.data;
    const allowed = mediaType === "image" ? server.imageModelIds : server.videoModelIds;
    const modelId = input.model || (allowed.length === 1 ? allowed[0] : "");
    if (!allowed.includes(modelId)) return textResult("El modelo no está autorizado en este MCP.", true);
    const capability = await findCapability(mediaType, modelId);
    if (!capability) return textResult("El modelo seleccionado ya no está disponible.", true);
    if (input.prompt.length > (capability.prompt_max ?? 20000)) return textResult("El prompt supera el límite del modelo.", true);
    try { await validateRemoteUrls([input.input_image_url, ...(input.reference_image_urls ?? [])]); }
    catch (error) { return textResult(error instanceof Error ? error.message : "URL de referencia inválida.", true); }

    const params: CanonicalParams = {
        model_id: modelId,
        prompt: input.prompt,
        negative_prompt: input.negative_prompt,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        duration: input.duration === undefined ? undefined : String(input.duration),
        seed: input.seed,
        generate_audio: input.generate_audio,
        field_values: input.parameters,
    };
    const firstImageSlot = capability.media_slots.find((slot) => slot.kind === "image" && !slot.multiple && slot.type !== "reference");
    const media: CanonicalMediaInputs = {
        images: input.input_image_url && firstImageSlot ? { [firstImageSlot.id]: input.input_image_url } : undefined,
        reference_images: [...(!firstImageSlot && input.input_image_url ? [input.input_image_url] : []), ...(input.reference_image_urls ?? [])],
    };
    try {
        const taskId = await submitGeneration({ mediaType, modelId, capabilities: capability, params, media, reuseState: { mcpServerId: server.id } });
        return textResult({ task_id: taskId, status: "submitted", next: "Call get_generation with this task_id until status is completed or failed." });
    } catch (error) { return textResult(publicErrorMessage(error), true); }
}

async function getGeneration(req: NextRequest, server: McpServerConfig, raw: unknown) {
    const parsed = z.object({ task_id: z.string().min(1).max(100) }).strict().safeParse(raw);
    if (!parsed.success) return textResult("task_id inválido.", true);
    await initStore();
    const task = getTask(parsed.data.task_id);
    if (!task || !taskBelongsToServer(task, server.id)) return textResult("Generación no encontrada en este MCP.", true);
    const status = task.status ?? task.freepik_status ?? "IN_PROGRESS";
    const paths = status === "COMPLETED" ? taskMediaPaths(task) : [];
    const files = paths.map((_, index) => signedMediaUrl(req, server, task.task_id, index));
    const summary = { task_id: task.task_id, media_type: task.media_type, status: status.toLowerCase(), files, error: task.error_message };
    if (status === "COMPLETED" && task.media_type === "image") {
        const previews = await imagePreviewContent(paths);
        if (previews.length) return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }, ...previews] };
    }
    return textResult(summary);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
    const { serverId } = await params;
    const server = await authenticateMcpServer(serverId, bearerToken(req));
    if (!server) return rpcError(null, -32001, "MCP no autorizado o desactivado.", 401);
    const limited = await limitRequest(`mcp:${serverId}`, 60); if (limited) return limited;
    let message: RpcRequest;
    try { message = JSON.parse(Buffer.from(await readLimitedBody(req, 64 * 1024)).toString("utf8")) as RpcRequest; }
    catch { return rpcError(null, -32700, "JSON inválido."); }
    if (message.jsonrpc !== "2.0" || !message.method) return rpcError(message.id, -32600, "Solicitud JSON-RPC inválida.");
    void touchMcpServer(server.id).catch(() => undefined);
    if (message.method === "initialize") return response(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: "1.0.0", description: server.description || undefined },
    });
    if (message.method === "notifications/initialized") return new NextResponse(null, { status: 202 });
    if (message.method === "ping") return response(message.id, {});
    if (message.method === "tools/list") return response(message.id, { tools: await listTools(server) });
    if (message.method === "tools/call") {
        const call = z.object({ name: z.string(), arguments: z.unknown().optional() }).safeParse(message.params);
        if (!call.success) return rpcError(message.id, -32602, "Parámetros inválidos.");
        if (call.data.name === "generate_image" && server.imageModelIds.length) return response(message.id, await submit(server, "image", call.data.arguments));
        if (call.data.name === "generate_video" && server.videoModelIds.length) return response(message.id, await submit(server, "video", call.data.arguments));
        if (call.data.name === "get_generation") return response(message.id, await getGeneration(req, server, call.data.arguments));
        return rpcError(message.id, -32602, "Herramienta no disponible.");
    }
    if (message.id === undefined) return new NextResponse(null, { status: 202 });
    return rpcError(message.id, -32601, "Método no encontrado.");
}

export async function GET() {
    return NextResponse.json({ error: "Este MCP usa Streamable HTTP. Envía solicitudes JSON-RPC por POST." }, { status: 405, headers: { Allow: "POST" } });
}
