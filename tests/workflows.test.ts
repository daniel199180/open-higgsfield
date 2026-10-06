import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { templateGraph, blankWorkflowGraph } from "../src/workflows/templates";
import { validateGraph, validateRunnable, canonicalParams, executionGraph } from "../src/workflows/validation";
import { publicRun, type WorkflowRun, type Workflow } from "../src/workflows/types";
import type { ModelCapabilities } from "../src/models/capabilities/types";
import type { GenerationProvider } from "../src/providers/types";

const cap: ModelCapabilities = {
    id: "test-image", label: "Test", group: "Test", family: "Test", variant: "", provider: "openrouter",
    prompt_required: true, duration: false, aspect_ratio: false, size: false, resolution_variant: false,
    negative_prompt: false, cfg_scale: false, style: false, shot_type: false, prompt_expansion: false, elements: false,
    media_slots: [{ id: "start_image", label: "Inicio", kind: "image" }], custom_fields: [{ id: "aspect_ratio", label: "Ratio", type: "select", options: ["1:1"] }],
};
test("new workflow creates an independent editable draft without billable nodes", () => {
    const first = blankWorkflowGraph();
    const second = blankWorkflowGraph();
    assert.deepEqual(validateGraph(first), first);
    assert.equal(first.nodes.length, 1);
    assert.equal(first.nodes[0].kind, "prompt");
    assert.equal(first.edges.length, 0);
    first.nodes[0].config.text = "An edited draft";
    assert.equal(second.nodes[0].config.text, "");
    assert.throws(() => validateRunnable(second, {}), /Escribe el texto/);
});
test("workflow graph rejects cycles, duplicate ports, mismatched types and extra secrets", () => {
    const graph = templateGraph("demo");
    assert.equal(validateGraph(graph).nodes.length, 3);
    assert.throws(() => validateGraph({ ...graph, apiKey: "private" }));
    const duplicate = structuredClone(graph); duplicate.edges.push({ ...graph.edges[0], id: "other" });
    assert.throws(() => validateGraph(duplicate), /una conexión/);
    const cycle = structuredClone(graph); cycle.edges[0].source = "output";
    assert.throws(() => validateGraph(cycle), /ciclos/);
    const mismatch = structuredClone(graph); mismatch.nodes[1].config.valueKind = "image";
    assert.throws(() => validateGraph(mismatch), /compatibles/);
    assert.equal(executionGraph(graph, "approve").nodes.length, 2);
    assert.throws(() => executionGraph(graph, "missing"));
    const many = templateGraph("image");
    for (let i = 0; i < 6; i++) many.nodes.push({ ...many.nodes[1], id: `image${i}` });
    assert.throws(() => validateGraph(many), /6 generaciones/);
});
test("parameters are model-specific, no invented defaults or arbitrary provider fields", () => {
    const node = templateGraph("image").nodes[1];
    assert.deepEqual(canonicalParams(node, cap, "Hello"), { model_id: cap.id, prompt: "Hello", field_values: {} });
    assert.throws(() => canonicalParams({ ...node, config: { params: { aspect_ratio: "9:16" } } }, cap, "Hello"), /no admitido/);
    assert.throws(() => canonicalParams({ ...node, config: { params: { callback_url: "https://attacker.invalid" } } }, cap, "Hello"), /no compatible/);
    assert.throws(() => validateRunnable(templateGraph("image"), { image: { ...cap, provider: "api-market" } }), /contrato/);
});

test("durable workflow lifecycle, approval, idempotency, crash recovery and safe output", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-workflow-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = dir;
    delete process.env.WORKFLOWS_DATABASE_URL;
    const { workflowStore, createSqliteStore } = await import("../src/workflows/store");
    const { saveWorkflow, enqueueRun, runAction } = await import("../src/workflows/service");
    const { processWorkflowStep, claimStep } = await import("../src/workflows/engine");
    const store = workflowStore();
    let sequence = 0;
    async function enqueue(graph = templateGraph("demo"), caps: WorkflowRun["capabilities"] = {}) {
        const workflow = await saveWorkflow({ name: "Test", graph });
        const key = `request-${++sequence}`;
        const run = await store.transaction(docs => enqueueRun(docs, workflow, graph, caps, key, key));
        return { workflow, run, key };
    }
    await t.test("saved graphs survive a separate process and optimistic locking protects other tabs", async () => {
        const { workflow } = await enqueue();
        await assert.rejects(saveWorkflow({ ...workflow, revision: 0 }), /otra pestaña/);
        const filename = path.join(dir, "workflows/workflows.sqlite");
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); console.log(db.prepare('SELECT count(*) AS n FROM workflow_documents').get().n)", filename], { encoding: "utf8" });
        assert.equal(child.status, 0); assert.ok(Number(child.stdout.trim()) >= 2);
        assert.equal((await createSqliteStore(filename).read<Workflow>(`workflow:${workflow.id}`))?.name, "Test");
        const runs = await store.list<WorkflowRun>("run:");
        await runAction(runs[0].id, "cancel");
    });
    await t.test("text -> approval -> output pauses and resumes once", async () => {
        const { run, workflow, key } = await enqueue();
        const duplicate = await store.transaction(docs => enqueueRun(docs, workflow, workflow.graph, {}, key, key));
        assert.equal(duplicate.id, run.id);
        await assert.rejects(store.transaction(docs => enqueueRun(docs, workflow, workflow.graph, {}, key, "changed")), /otra solicitud/);
        await processWorkflowStep(); await processWorkflowStep();
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.status, "approval");
        assert.equal(await processWorkflowStep(), false);
        await runAction(run.id, "approve", "approve");
        await assert.rejects(runAction(run.id, "approve", "approve"), /esperando aprobación/);
        await processWorkflowStep();
        const done = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(done?.status, "completed");
        assert.equal(done?.nodes.output.value?.text, workflow.graph.nodes[0].config.text);
    });
    let submits = 0, polls = 0;
    const provider: GenerationProvider = {
        id: "openrouter",
        async submit() { submits++; return { status: "CREATED", providerTaskId: "job-1", operation: { job: "job-1" } }; },
        async poll() { polls++; return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }], usage: { totalTokens: 1290, costUsd: 0.04 } }; },
    };
    const deps = { provider: () => provider, persist: async () => ["asset-id"] };
    await t.test("image -> approval -> video passes the saved image only after approval", async () => {
        const graph = templateGraph("video");
        const { run } = await enqueue(graph, { image: cap, video: { ...cap, id: "test-video" } });
        const submittedTypes: string[] = [];
        const synchronous: GenerationProvider = { ...provider, async submit(request) {
            submittedTypes.push(request.mediaType);
            if (request.mediaType === "video") assert.equal(request.media.images?.start_image, "data:image/png;base64,test");
            return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] };
        } };
        const pipeline = { provider: () => synchronous, persist: async () => ["asset-id"], reference: async () => "data:image/png;base64,test" };
        for (let i = 0; i < 3; i++) await processWorkflowStep(pipeline);
        assert.deepEqual(submittedTypes, ["image"]);
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.status, "approval");
        await runAction(run.id, "approve", "approve");
        await processWorkflowStep(pipeline); await processWorkflowStep(pipeline);
        assert.deepEqual(submittedTypes, ["image", "video"]);
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.nodes.output.value?.kind, "video");
    });
    await t.test("async provider is submitted once and polling survives engine reload", async () => {
        const { run } = await enqueue(templateGraph("image"), { image: cap });
        await processWorkflowStep(deps); await processWorkflowStep(deps);
        const submitted = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(submitted?.nodes.image.status, "polling"); assert.equal(submits, 1);
        await store.transaction(docs => { (docs.get(`run:${run.id}`) as WorkflowRun).nodes.image.nextPollAt = 0; });
        await processWorkflowStep(deps); await processWorkflowStep(deps);
        const done = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(done?.status, "completed"); assert.equal(submits, 1); assert.equal(polls, 1);
        const { billingStore } = await import("../src/billing/store");
        const usage = (await billingStore().summary()).recent.find(r => r.id === `workflow:${run.id}:image`);
        assert.equal(usage?.costUsd, 0.04); assert.equal(usage?.totalTokens, 1290);
        assert.equal(JSON.stringify(publicRun(done!)).includes('"operation"'), false);
        assert.equal(JSON.stringify(publicRun(done!)).includes('"capabilities"'), false);
    });
    await t.test("expired submission lease is review-only and never generates twice", async () => {
        const { run } = await enqueue(templateGraph("image"), { image: cap });
        await processWorkflowStep(deps);
        await store.transaction(docs => { const r = docs.get(`run:${run.id}`) as WorkflowRun; r.nodes.image.status = "submitting"; r.leaseOwner = "crashed-worker"; r.leaseUntil = 0; });
        assert.equal(await processWorkflowStep(deps), false);
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.nodes.image.status, "review");
        assert.equal(submits, 1);
    });
    await t.test("leases prevent concurrent work and cancellation prevents pending charges", async () => {
        const { run } = await enqueue(templateGraph("image"), { image: cap });
        const first = await store.transaction(docs => claimStep(docs, "worker-a"));
        const second = await store.transaction(docs => claimStep(docs, "worker-b"));
        assert.ok(first); assert.equal(second, undefined);
        await runAction(run.id, "cancel");
        await store.transaction(docs => { const r = docs.get(`run:${run.id}`) as WorkflowRun; r.leaseUntil = 0; });
        assert.equal(await processWorkflowStep(deps), false); assert.equal(submits, 1);
    });
    await t.test("provider errors never leak secrets and do not trigger a resubmission", async () => {
        const { run } = await enqueue(templateGraph("image"), { image: cap });
        const failing: GenerationProvider = { ...provider, async submit() { throw new Error("secret-api-key upstream exception"); } };
        await processWorkflowStep({ ...deps, provider: () => failing }); await processWorkflowStep({ ...deps, provider: () => failing });
        const result = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(result?.status, "review"); assert.equal(JSON.stringify(publicRun(result!)).includes("secret-api-key"), false);
    });
    await t.test("image assets preserve transparency, strip active formats and reject path traversal", async () => {
        const { saveAsset, readAsset } = await import("../src/workflows/assets");
        const sharp = (await import("sharp")).default;
        const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
        const asset = await saveAsset(png, "image");
        const bytes = (await readAsset(asset.id)).data;
        assert.equal((await sharp(bytes).metadata()).hasAlpha, true);
        await assert.rejects(saveAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), "image"));
        await assert.rejects(readAsset("../../.env.local"));
        await assert.rejects(saveAsset(Buffer.from("<html>bad</html>"), "video"));
    });
});
