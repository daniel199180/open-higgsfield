import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

let storage: string;
let importer: typeof import("../src/workflows/gallery-import");
let assets: typeof import("../src/workflows/assets");
let tasks: typeof import("../src/lib/task-store");
before(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-gallery-import-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = storage;
    importer = await import("../src/workflows/gallery-import");
    assets = await import("../src/workflows/assets");
    tasks = await import("../src/lib/task-store");
});
after(async () => { if (storage) await fs.rm(storage, { recursive: true, force: true }); });

test("gallery asset is reused and rejected when it is not an image", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0 } } }).png().toBuffer();
    const asset = await assets.saveAsset(png, "image");
    assert.equal((await importer.importGalleryImage(`asset:${asset.id}`)).id, asset.id);
    await assert.rejects(importer.importGalleryImage("asset:not-an-id"), /no es válida/);
});

test("generated gallery image becomes a durable workflow input without changing the original", async () => {
    await tasks.initStore();
    const original = await sharp({ create: { width: 5, height: 3, channels: 4, background: { r: 50, g: 100, b: 150, alpha: 0 } } }).png().toBuffer();
    const file = path.join(storage, "generated.png");
    await fs.writeFile(file, original);
    tasks.getStore().set("gallery-test", {
        task_id: "gallery-test", model_id: "test", created_at: new Date().toISOString(),
        media_type: "image", status: "COMPLETED", result_paths: [file], events: [], _done: true,
    });
    const asset = await importer.importGalleryImage("task:gallery-test:0");
    const saved = await assets.readAsset(asset.id);
    assert.equal(saved.asset.kind, "image");
    assert.notEqual(asset.id, "gallery-test");
    assert.equal((await sharp(saved.data).metadata()).hasAlpha, true);
    assert.deepEqual(await fs.readFile(file), original);
    await assert.rejects(importer.importGalleryImage("task:gallery-test:1"), /No se encuentra/);
});

test("inline gallery result can also be imported and unavailable tasks are rejected", async () => {
    await tasks.initStore();
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    tasks.getStore().set("inline-test", {
        task_id: "inline-test", model_id: "test", created_at: new Date().toISOString(),
        media_type: "image", status: "COMPLETED", result_urls: [`data:image/png;base64,${png.toString("base64")}`], events: [], _done: true,
    });
    const asset = await importer.importGalleryImage("task:inline-test:0");
    assert.equal((await assets.readAsset(asset.id)).asset.mime, "image/png");
    await assert.rejects(importer.importGalleryImage("task:missing:0"), /ya no está disponible/);
});
