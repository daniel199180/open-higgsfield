import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, readLimitedBody, securityError } from "@/lib/api-security";
import { workflowStore } from "@/workflows/store";
import { currentEditorSnapshot, editorHistorySchema, type EditorDocument } from "@/lib/editor-document";
import { getTask, initStore } from "@/lib/task-store";

export const runtime = "nodejs";
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,110}$/);
const inputSchema = z.object({ id: identifier, title: z.string().min(1).max(160), sourceTaskId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), sourceIndex: z.number().int().min(0).max(9), expectedRevision: z.number().int().min(0), history: editorHistorySchema }).strict();
const headers = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (id) return NextResponse.json({ document: await workflowStore().read<EditorDocument>(`editor:${identifier.parse(id)}`) ?? null }, { headers });
        const documents = await workflowStore().list<EditorDocument>("editor:");
        return NextResponse.json({ documents: documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ history, ...doc }) => ({ ...doc, versions: history.entries.length, previewTaskId: currentEditorSnapshot(history).taskId, previewIndex: currentEditorSnapshot(history).index })) }, { headers });
    } catch (error) { return error instanceof z.ZodError ? NextResponse.json({ error: "Documento inválido." }, { status: 400, headers }) : securityError(error); }
}
export async function PUT(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new Error("ERR_INVALID_BODY");
        let value: unknown;
        try { value = JSON.parse(Buffer.from(await readLimitedBody(req, 12 * 1024 * 1024)).toString("utf8")); } catch (error) { if (error instanceof SyntaxError) throw new Error("ERR_INVALID_BODY"); throw error; }
        const input = inputSchema.parse(value);
        await initStore();
        const taskIds = new Set([input.sourceTaskId, ...input.history.entries.flatMap(entry => [entry.snapshot.taskId, entry.snapshot.layerTaskId]).filter(Boolean)]);
        for (const taskId of taskIds) {
            const task = getTask(taskId);
            if (!task || task.media_type !== "image" || task.status !== "COMPLETED") return NextResponse.json({ error: "Una imagen del documento ya no está disponible." }, { status: 400, headers });
        }
        const result = await workflowStore().transaction(docs => {
            const key = `editor:${input.id}`;
            const existing = docs.get(key) as EditorDocument | undefined;
            if ((existing?.revision ?? 0) !== input.expectedRevision || (existing && (existing.sourceTaskId !== input.sourceTaskId || existing.sourceIndex !== input.sourceIndex))) return null;
            const document: EditorDocument = { id: input.id, schemaVersion: 1, title: input.title, sourceTaskId: input.sourceTaskId, sourceIndex: input.sourceIndex, revision: input.expectedRevision + 1, updatedAt: new Date().toISOString(), history: input.history };
            docs.set(key, document); return document;
        });
        if (!result) return NextResponse.json({ error: "Esta edición cambió en otra pestaña. No se sobrescribió: recarga para abrir la versión guardada." }, { status: 409, headers });
        return NextResponse.json({ revision: result.revision, updatedAt: result.updatedAt }, { headers });
    } catch (error) { return error instanceof z.ZodError ? NextResponse.json({ error: "El documento supera los límites o contiene datos inválidos. Conserva esta pestaña abierta." }, { status: 400, headers }) : securityError(error); }
}
