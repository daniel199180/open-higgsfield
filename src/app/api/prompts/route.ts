import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readJsonBody } from "@/lib/api-security";
import { deletePrompt, listSavedPrompts, savePrompt } from "@/prompts/server";
import { WorkflowError } from "@/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const promptSchema = z.object({
    id: z.uuid().optional(),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(12000),
    negativePrompt: z.string().max(4000).optional(),
    tags: z.array(z.string().max(60)).max(20).optional(),
    sourceImageUrl: z.string().max(1000).optional(),
}).strict();

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try { return NextResponse.json({ prompts: await listSavedPrompts() }, { headers: { "Cache-Control": "private, no-store" } }); }
    catch { return NextResponse.json({ error: "No se pudo cargar la biblioteca de prompts." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("prompts-write", 60); if (limited) return limited;
    try {
        const input = promptSchema.parse(await readJsonBody(req));
        return NextResponse.json({ prompt: await savePrompt(input) }, { status: input.id ? 200 : 201 });
    } catch (error) {
        if (error instanceof z.ZodError) return NextResponse.json({ error: "Revisa el título y el contenido del prompt." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo guardar el prompt." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}

export async function DELETE(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("prompts-write", 60); if (limited) return limited;
    try {
        const id = z.uuid().parse(req.nextUrl.searchParams.get("id"));
        await deletePrompt(id);
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof z.ZodError) return NextResponse.json({ error: "El prompt no es válido." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo borrar el prompt." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
