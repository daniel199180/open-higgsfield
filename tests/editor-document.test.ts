import test from "node:test";
import assert from "node:assert/strict";
import { appendEditorRevision, blankEditorSnapshot, currentEditorSnapshot, editorHistorySchema, type EditorHistory } from "../src/lib/editor-document";

function original(): EditorHistory {
    return { cursor: "original", entries: [{ id: "original", parentId: "", label: "Original", createdAt: new Date().toISOString(), snapshot: blankEditorSnapshot("image-1", 0) }] };
}
test("editor history preserves cross-tool drafts, composition and branches", () => {
    let history = original();
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), textLayers: [{ id: "text-1", text: "Oferta", x: 50, y: 20, fontFamily: "Arial", fontSize: 50, fontWeight: 700, color: "#ffffff", align: "center", visible: true }] }, "Texto");
    const textVersion = history.cursor;
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), strokes: { mask: [{ radius: .02, points: [[.2, .3], [.3, .4]] }], erase: [] } }, "Pintar");
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), comments: [{ id: "comment", x: .4, y: .5, text: "Cambiar color" }] }, "Comentarios");
    assert.equal(currentEditorSnapshot(history).textLayers[0].text, "Oferta");
    assert.equal(currentEditorSnapshot(history).strokes.mask.length, 1);
    const previousBranch = history.cursor;
    history = { ...history, cursor: textVersion };
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), padding: { left: 20, right: 0, top: 0, bottom: 0 } }, "Expandir");
    assert.ok(history.entries.some(entry => entry.id === previousBranch), "editing an old revision never discards subsequent work");
    assert.equal(history.entries.at(-1)?.parentId, textVersion);
    assert.deepEqual(editorHistorySchema.parse(JSON.parse(JSON.stringify(history))), history);
});
test("local gestures coalesce without overwriting the original or an existing branch", () => {
    let history = original();
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), layerOrder: [1, 2] }, "Mover", true, "2026-10-15T12:00:00.000Z");
    history = appendEditorRevision(history, { ...currentEditorSnapshot(history), layerOrder: [2, 1] }, "Mover", true, "2026-10-15T12:00:00.200Z");
    assert.equal(history.entries.length, 2);
    assert.deepEqual(history.entries[0].snapshot.layerOrder, []);
    assert.deepEqual(currentEditorSnapshot(history).layerOrder, [2, 1]);
    history = appendEditorRevision(history, blankEditorSnapshot("generated", 0), "IA", false);
    assert.deepEqual(history.entries[1].snapshot.layerOrder, [2, 1], "flattened AI result preserves its editable parent");
    assert.deepEqual(currentEditorSnapshot(history).textLayers, []);
});
test("editor documents reject unsafe asset ids, malformed history and unbounded values", () => {
    const history = original();
    assert.equal(editorHistorySchema.safeParse({ ...history, cursor: "missing" }).success, false);
    assert.equal(editorHistorySchema.safeParse({ ...history, entries: [...history.entries, history.entries[0]] }).success, false);
    history.entries[0].snapshot.taskId = "../../private";
    assert.equal(editorHistorySchema.safeParse(history).success, false);
    history.entries[0].snapshot.taskId = "image-1";
    history.entries[0].snapshot.layerTransforms[1] = { x: Infinity, y: 0, scale: 1 };
    assert.equal(editorHistorySchema.safeParse(history).success, false);
});

test("authenticated editor persistence, revision conflicts, reload and local composite snapshots", async t => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const sharp = (await import("sharp")).default;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-editor-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "http://localhost:3000";
    process.env.OPEN_HIGGSFIELD_SETUP_TOKEN = crypto.randomUUID();
    delete process.env.WORKFLOWS_DATABASE_URL;
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const auth = await import("../src/lib/admin-auth");
    await auth.initializeAdminSetup();
    const admin = await auth.createAdmin("test-editor-password-only-123456", process.env.OPEN_HIGGSFIELD_SETUP_TOKEN);
    const { NextRequest } = await import("next/server");
    const { GET, PUT } = await import("../src/app/api/images/documents/route");
    const { POST } = await import("../src/app/api/images/editor-snapshot/route");
    const { persistImageEditSource } = await import("../src/lib/image-edit-source");
    const { getTask } = await import("../src/lib/task-store");
    const { createSqliteStore } = await import("../src/workflows/store");
    const pixels = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const source = await persistImageEditSource(pixels);
    const history = original(); history.entries[0].snapshot.taskId = source.taskId;
    const body = { id: "saved-editor", title: "Prueba de edición", sourceTaskId: source.taskId, sourceIndex: 0, expectedRevision: 0, history };
    const headers = { "Content-Type": "application/json", Origin: "http://localhost:3000", Cookie: `${auth.COOKIE_NAME}=${admin.token}` };
    const request = (payload = body, extraHeaders = headers) => new NextRequest("http://localhost:3000/api/images/documents", { method: "PUT", headers: extraHeaders, body: JSON.stringify(payload) });
    assert.equal((await PUT(request(body, { ...headers, Cookie: "" }))).status, 401);
    assert.equal((await PUT(request(body, { ...headers, Origin: "https://untrusted.test" }))).status, 403);
    assert.equal((await PUT(request())).status, 200);
    assert.equal((await PUT(request())).status, 409, "stale tabs cannot overwrite a saved document");
    const reopened = await GET(new NextRequest("http://localhost:3000/api/images/documents?id=saved-editor", { headers }));
    const saved = (await reopened.json()).document;
    assert.equal(saved.revision, 1); assert.deepEqual(saved.history, history);
    const disk = createSqliteStore(path.join(directory, "workflows", "workflows.sqlite"));
    assert.deepEqual(await disk.read("editor:saved-editor"), saved, "another store instance restores the complete history");
    const snapshot = await POST(new NextRequest(`http://localhost:3000/api/images/editor-snapshot?taskId=${source.taskId}&index=0`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: pixels }));
    assert.equal(snapshot.status, 201);
    const result = await snapshot.json();
    assert.equal(getTask(result.taskId)?.reuse_state?.editor_internal, true);
    assert.equal(getTask(result.taskId)?.reuse_state?.edit_root_task_id, source.taskId);
    assert.deepEqual(await fs.readFile(getTask(result.taskId)!.result_paths![0]), pixels);
});
