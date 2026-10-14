import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, securityError } from "@/lib/api-security";
import { generationEndpoint } from "@/lib/generation-request";
import { decomposeImage, editImageLayer, ImageLayerError } from "@/lib/image-layers";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.discriminatedUnion("operation", [
    z.object({
        operation: z.literal("decompose"),
        source: z.object({ type: z.literal("task"), taskId: z.string().min(1).max(100), index: z.number().int().min(0).max(9) }).strict(),
        prompt: z.string().max(3000).optional(),
        size: z.enum(["auto", "1K", "1.5K", "2K"]).optional(),
    }).strict(),
    z.object({
        operation: z.literal("edit-layer"),
        layerTaskId: z.string().min(1).max(100),
        layerIndex: z.number().int().min(1).max(16),
        prompt: z.string().min(1).max(3000),
    }).strict(),
]);

export async function POST(req: NextRequest) {
    return generationEndpoint(req, handleRequest);
}

async function handleRequest(req: NextRequest) {
    try {
        const input = requestSchema.parse(await readJsonBody(req));
        if (input.operation === "decompose") {
            const result = await decomposeImage(input.source.taskId, input.source.index, input.prompt?.trim() ?? "", input.size ?? "auto");
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
