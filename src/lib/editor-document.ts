import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const finite = z.number().finite();
export const editorToolSchema = z.enum(["prompt", "mask", "erase", "comments", "background", "expand", "layers", "text"]);
export type EditorTool = z.infer<typeof editorToolSchema>;
export const textLayerSchema = z.object({
    id, text: z.string().max(2000), x: finite.min(0).max(100), y: finite.min(0).max(100),
    fontFamily: z.string().regex(/^[\w .'-]{1,100}$/), fontSize: finite.min(8).max(2000),
    fontWeight: finite.min(300).max(900), color: z.string().regex(/^#[0-9a-f]{6}$/i),
    align: z.enum(["left", "center", "right"]), visible: z.boolean(),
}).strict();
export type EditorTextLayer = z.infer<typeof textLayerSchema>;
const strokeSchema = z.object({ radius: finite.min(0.001).max(1), points: z.array(z.tuple([finite.min(0).max(1), finite.min(0).max(1)])).min(1).max(10000) }).strict();
export type EditorStroke = z.infer<typeof strokeSchema>;
export const editorSnapshotSchema = z.object({
    taskId: id, index: z.number().int().min(0).max(9), layerTaskId: z.union([id, z.literal("")]),
    layerOrder: z.array(z.number().int().min(0).max(32)).max(33),
    layerVisibility: z.record(z.string().regex(/^\d{1,2}$/), z.boolean()),
    deletedLayerIndexes: z.record(z.string().regex(/^\d{1,2}$/), z.boolean()),
    layerTransforms: z.record(z.string().regex(/^\d{1,2}$/), z.object({ x: finite.min(-100).max(100), y: finite.min(-100).max(100), scale: finite.min(0.5).max(2) }).strict()),
    textLayers: z.array(textLayerSchema).max(100),
    instructions: z.record(editorToolSchema, z.string().max(6000)),
    comments: z.array(z.object({ id, x: finite.min(0).max(1), y: finite.min(0).max(1), text: z.string().max(400) }).strict()).max(8),
    strokes: z.object({ mask: z.array(strokeSchema).max(300), erase: z.array(strokeSchema).max(300) }).strict(),
    padding: z.object({ left: finite.min(0).max(40000), right: finite.min(0).max(40000), top: finite.min(0).max(40000), bottom: finite.min(0).max(40000) }).strict(),
}).strict();
export type EditorSnapshot = z.infer<typeof editorSnapshotSchema>;
export const editorHistorySchema = z.object({
    entries: z.array(z.object({ id, parentId: z.union([id, z.literal("")]), label: z.string().max(160), createdAt: z.string().datetime(), snapshot: editorSnapshotSchema }).strict()).min(1).max(2000),
    cursor: id,
}).strict().superRefine((history, ctx) => {
    const seen = new Set<string>();
    for (const entry of history.entries) {
        if (seen.has(entry.id) || (entry.parentId && !seen.has(entry.parentId))) ctx.addIssue({ code: "custom", message: "Historial inválido" });
        seen.add(entry.id);
    }
    if (!seen.has(history.cursor)) ctx.addIssue({ code: "custom", message: "Versión inexistente" });
});
export type EditorHistory = z.infer<typeof editorHistorySchema>;
export interface EditorDocument {
    id: string; schemaVersion: 1; title: string; sourceTaskId: string; sourceIndex: number;
    revision: number; updatedAt: string; history: EditorHistory;
}
export function blankEditorSnapshot(taskId: string, index: number): EditorSnapshot {
    return { taskId, index, layerTaskId: "", layerOrder: [], layerVisibility: {}, deletedLayerIndexes: {}, layerTransforms: {}, textLayers: [],
        instructions: { prompt: "", mask: "", erase: "", comments: "", background: "", expand: "", layers: "", text: "" },
        comments: [], strokes: { mask: [], erase: [] }, padding: { left: 0, right: 0, top: 0, bottom: 0 } };
}
export function currentEditorSnapshot(history: EditorHistory): EditorSnapshot { return history.entries.find(entry => entry.id === history.cursor)!.snapshot; }
/** Branches are retained when editing an older version. Only a recent leaf gesture can coalesce. */
export function appendEditorRevision(history: EditorHistory, snapshot: EditorSnapshot, label: string, coalesce = false, now = new Date().toISOString()): EditorHistory {
    const current = history.entries.find(entry => entry.id === history.cursor)!;
    if (JSON.stringify(current.snapshot) === JSON.stringify(snapshot)) return history;
    if (coalesce && history.entries.length > 1 && current === history.entries.at(-1) && current.label === label && Date.parse(now) - Date.parse(current.createdAt) < 700) {
        return { ...history, entries: [...history.entries.slice(0, -1), { ...current, snapshot, createdAt: now }] };
    }
    const entry = { id: crypto.randomUUID(), parentId: current.id, label, createdAt: now, snapshot };
    return { entries: [...history.entries, entry], cursor: entry.id };
}
