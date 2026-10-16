import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ImageLayerSet, ImageTask } from "../src/types";

test("documented APIMart response survives decomposition, persistence and pixel reconstruction", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-layers-contract-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    process.env.APIMART_API_KEY = "test-only-never-sent";
    delete process.env.DATABASE_URL;
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    t.mock.method(fs, "statfs", async () => ({ bavail: 1_000_000, bsize: 4096 }));
    const { decomposeImage, recoverLayerDecomposition, listRecoverableLayerJobs } = await import("../src/lib/image-layers");
    const { persistImageEditSource } = await import("../src/lib/image-edit-source");
    const { getTask } = await import("../src/lib/task-store");
    const makePng = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
    const base = await makePng(800, 600, "#173c59");
    const front = await makePng(360, 300, "#ef4433");
    const back = await makePng(200, 160, "#46bb71");
    const original = await sharp(base).composite([{ input: back, left: 200, top: 100 }, { input: await sharp(front).resize(120, 100).toBuffer(), left: 260, top: 140 }]).png().toBuffer();
    const source = await persistImageEditSource(original, "Contrato Seedream: posiciones y orden");
    const packet = {
        url: [base, front, back].map(buffer => `data:image/png;base64,${buffer.toString("base64")}`),
        sizes: ["800x600", "360x300", "200x160"], output_formats: ["png", "png", "png"], layer_decomposition: true,
        layers: [
            { z_index: 0, size: "800x600", name: "Base" },
            { z_index: 2, size: "360x300", name: "Frente rojo", bounding_box: { absolute: [260, 140, 380, 240] } },
            { z_index: 1, size: "200x160", name: "Fondo verde", bounding_box: { absolute: [200, 100, 400, 260] } },
        ],
    };
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://api.apimart.ai");
        requests++;
        if (init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            assert.equal(body.layer_decomposition, true);
            assert.equal(body.model, "seedream-5-0-pro");
            return Response.json({ data: [{ task_id: requests === 1 ? "contract-job" : "contract-recovery" }] });
        }
        return Response.json({ data: { status: "completed", result: { images: [packet] } } });
    });
    const result = await decomposeImage(source.taskId, 0, "", "auto");
    const task = getTask(result.taskId) as ImageTask;
    const set = task.reuse_state!.layer_set as ImageLayerSet;
    assert.equal(task.provider_task_id, "contract-job");
    assert.equal(set.version, 4);
    assert.equal(set.referenceIndex, 0);
    assert.equal(set.baseIndex, 1);
    assert.deepEqual(set.layers[2].boundingBox.absolute, [260, 140, 380, 240]);
    assert.equal(set.layers[2].zIndex, 2);
    assert.equal(set.layers[3].zIndex, 1);
    const overlays = await Promise.all(set.layers.filter(l => l.role === "layer").sort((a, b) => a.zIndex - b.zIndex).map(async l => ({ input: await sharp(task.result_paths![l.index]).resize(l.boundingBox.absolute[2] - l.boundingBox.absolute[0], l.boundingBox.absolute[3] - l.boundingBox.absolute[1]).toBuffer(), left: l.boundingBox.absolute[0], top: l.boundingBox.absolute[1] })));
    const composite = await sharp(task.result_paths![set.baseIndex]).composite(overlays).ensureAlpha().raw().toBuffer();
    assert.deepEqual(composite, await sharp(original).ensureAlpha().raw().toBuffer(), "all pixels reconstruct at their original location and stacking order");
    const saved = JSON.parse(await fs.readFile(path.join(directory, "tasks_history.json"), "utf8"));
    assert.deepEqual(saved.find((entry: ImageTask) => entry.task_id === result.taskId).reuse_state.layer_set, set);
    const journals = (await fs.readdir(path.join(directory, "layer-jobs"))).filter(file => file.endsWith(".json"));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(await fs.readFile(path.join(directory, "layer-jobs", journals[0]), "utf8"));
    assert.equal(journal.response.data.result.images[0].layers[1].bounding_box.absolute[0], 260);
    const archive = path.join(directory, "layer-jobs", journals[0].replace(/\.json$/, ".assets"));
    assert.deepEqual(await fs.readFile(path.join(archive, "1.bin")), front, "original provider pixels are retained for recovery");
    assert.equal(requests, 2, "transport is mocked; no provider charges");
    assert.deepEqual(await listRecoverableLayerJobs(source.taskId, 0), []);
    const recovered = await recoverLayerDecomposition(journals[0].replace(/\.json$/, ""));
    assert.equal(recovered.taskId, task.task_id, "recovery is idempotent");
    assert.equal(requests, 2, "recovery never submits another paid job");

    if (process.env.LAYER_BROWSER_FIXTURE === "1") {
        const file = path.join(process.cwd(), "output/playwright/layers-contract.json");
        await fs.mkdir(path.dirname(file), { recursive: true });
        const images: Record<string, string[]> = { [source.taskId]: [original.toString("base64")] };
        images[result.taskId] = await Promise.all(task.result_paths!.map(async file => (await fs.readFile(file)).toString("base64")));
        await fs.writeFile(file, JSON.stringify({ sourceId: source.taskId, layerId: result.taskId, tasks: [getTask(source.taskId), task], images }));
    }

    // Metadata loss must not silently create another broken local task.
    packet.layers[1].bounding_box = undefined;
    await assert.rejects(decomposeImage(source.taskId, 0, "", "auto"), /Faltan posiciones/);
    const afterFailure = JSON.parse(await fs.readFile(path.join(directory, "tasks_history.json"), "utf8"));
    assert.equal(afterFailure.length, saved.length);
    const pending = await listRecoverableLayerJobs(source.taskId, 0);
    assert.equal(pending.length, 1);
    const pendingPath = path.join(directory, "layer-jobs", `${pending[0].id}.json`);
    const pendingJob = JSON.parse(await fs.readFile(pendingPath, "utf8"));
    pendingJob.response.data.result.images[0].layers[1].bounding_box = { absolute: [260, 140, 380, 240] };
    await fs.writeFile(pendingPath, JSON.stringify(pendingJob));
    const beforeRecovery = requests;
    const restored = await recoverLayerDecomposition(pending[0].id);
    assert.notEqual(restored.taskId, task.task_id);
    assert.equal(requests, beforeRecovery, "recover the archived response without any generation POST");
    assert.equal((await recoverLayerDecomposition(pending[0].id)).taskId, restored.taskId);
    await verifyDownloads();
});

async function verifyDownloads() {
    const { downloadLayerAssets } = await import("../src/lib/image-layers");
    const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: "red" } }).png().toBuffer();
    let active = 0; let max = 0; const calls: Record<string, number> = {};
    const download = async (url: string) => {
        calls[url] = (calls[url] || 0) + 1; active++; max = Math.max(active, max);
        await new Promise(resolve => setTimeout(resolve, 5)); active--;
        if (url === "first" && calls[url] === 1) throw new Error("ERR_MEDIA_HTTP_503");
        return image;
    };
    await downloadLayerAssets(["first", "second", "third"], "retry-job", download);
    assert.equal(calls.first, 2); assert.ok(max <= 2);
    await downloadLayerAssets(["first", "second", "third"], "retry-job", async () => { throw new Error("must use cache"); });
    let forbidden = 0;
    await assert.rejects(downloadLayerAssets(["unsafe"], undefined, async () => { forbidden++; throw new Error("ERR_UNSAFE_MEDIA_URL"); }), /descargar la capa/);
    assert.equal(forbidden, 1, "unsafe URLs are never retried or bypassed");
}
