import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, readJsonBody, securityError } from "@/lib/api-security";
import { generationEndpoint } from "@/lib/generation-request";
import { decomposeImage, editImageLayer, ImageLayerError, normalizeLayerTask, listRecoverableLayerJobs, recoverLayerDecomposition } from "@/lib/image-layers";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("recover"), jobId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({
        operation: z.literal("decompose"),
        source: z.object({ type: z.literal("task"), taskId: z.string().min(1).max(100), index: z.number().int().min(0).max(9) }).strict(),
        prompt: z.string().max(3000).optional(),
        size: z.enum(["auto", "1K", "1.5K", "2K"]).optional(),
    }).strict(),
    z.object({
        operation: z.literal("edit-layer"),
        layerTaskId: z.string().min(1).max(100),
        layerIndex: z.number().int().min(1).max(17),
        prompt: z.string().min(1).max(3000),
    }).strict(),
    z.object({
        operation: z.literal("normalize"),
        layerTaskId: z.string().min(1).max(100),
    }).strict(),
]);

export async function POST(req: NextRequest) {
    return generationEndpoint(req, handleRequest);
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const sourceTaskId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).parse(req.nextUrl.searchParams.get("sourceTaskId"));
        const index = z.coerce.number().int().min(0).max(17).parse(req.nextUrl.searchParams.get("index") ?? 0);
        return NextResponse.json({ jobs: await listRecoverableLayerJobs(sourceTaskId, index) }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return error instanceof z.ZodError ? NextResponse.json({ error: "Imagen inválida." }, { status: 400 }) : securityError(error); }
}

async function handleRequest(req: NextRequest) {
    try {
        const input = requestSchema.parse(await readJsonBody(req));
        if (input.operation === "recover") return NextResponse.json(await recoverLayerDecomposition(input.jobId), { status: 201, headers: { "Cache-Control": "private, no-store" } });
        if (input.operation === "decompose") {
            const result = await decomposeImage(input.source.taskId, input.source.index, input.prompt?.trim() ?? "", input.size ?? "auto");
            return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
        }
        if (input.operation === "normalize") {
            const result = await normalizeLayerTask(input.layerTaskId);
            return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
        }
        const result = await editImageLayer(input.layerTaskId, input.layerIndex, input.prompt);
        return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof ImageLayerError) return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof z.ZodError) return NextResponse.json({ error: "Revisa la imagen, la capa y las opciones enviadas." }, { status: 400 });
        return securityError(error);
    }
}
