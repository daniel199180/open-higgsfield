import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { templateGraph, blankWorkflowGraph, withManualTrigger } from "../src/workflows/templates";
import { validateGraph, validateRunnable, canonicalParams, executionGraph } from "../src/workflows/validation";
import { MAX_GENERATIONS, WorkflowError, publicRun, type WorkflowRun, type Workflow } from "../src/workflows/types";
import { angleFormats, angleFormatKey, angleKey, anglePrompt, rasterAngleModel } from "../src/workflows/sales-angles";
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
    assert.equal(first.nodes.length, 2);
    assert.equal(first.nodes[0].kind, "manualTrigger");
    assert.equal(first.nodes[1].kind, "prompt");
    assert.equal(first.edges[0].targetHandle, "start");
    first.nodes[1].config.text = "An edited draft";
    assert.equal(second.nodes[1].config.text, "");
    assert.throws(() => validateRunnable(second, {}), /Escribe el texto/);
});
test("manual trigger is a no-cost dependency and legacy templates remain valid", () => {
    const graph = withManualTrigger(templateGraph("demo"));
    assert.deepEqual(validateGraph(graph), graph);
    assert.equal(graph.nodes.filter(node => node.kind === "manualTrigger").length, 1);
    assert.equal(withManualTrigger(graph), graph);
    const duplicate = structuredClone(graph);
    duplicate.nodes.push({ ...duplicate.nodes[0], id: "other" });
    assert.throws(() => validateGraph(duplicate), /Solo se permite un disparador/);
    const wrong = structuredClone(graph);
    wrong.edges[0].targetHandle = "input";
    assert.throws(() => validateGraph(wrong), /solo se conecta/);
    const disconnected = structuredClone(graph);
    disconnected.edges.shift();
    assert.throws(() => validateGraph(disconnected), /Conecta el disparador/);
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
    for (let i = 0; i < MAX_GENERATIONS; i++) many.nodes.push({ ...many.nodes[1], id: `image${i}` });
    assert.throws(() => validateGraph(many), /30 bloques|30 generaciones/);
});
test("sales angles validate every row, format, output handle and total billable requests", () => {
    const graph = templateGraph("image");
    graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos de venta", position: { x: 300, y: 100 }, config: { angles: [
        { id: "benefit", text: "Ahorro de tiempo", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
        { id: "trust", text: "Confianza", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
    ] } };
    graph.edges[0].target = "angles";
    graph.edges[1].source = "angles";
    graph.edges[1].sourceHandle = "angle:benefit";
    assert.deepEqual(validateGraph(graph), graph);
    const caps = Object.fromEntries(graph.nodes[1].config.angles!.map(angle => [angleKey("angles", angle.id), cap]));
    validateRunnable(graph, caps);
    const badFormat = structuredClone(graph); badFormat.nodes[1].config.angles![0].format = "9:16";
    assert.throws(() => validateRunnable(badFormat, caps), /no admite el formato/);
    const badHandle = structuredClone(graph); badHandle.edges[1].sourceHandle = "angle:deleted";
    assert.throws(() => validateGraph(badHandle), /ya no existe/);
    const overflow = structuredClone(graph);
    overflow.nodes[1].config.angles = Array.from({ length: MAX_GENERATIONS }, (_, index) => ({ id: `a${index}`, text: `Angle ${index}`, modelId: cap.id, formatField: "aspect_ratio", format: "1:1" }));
    overflow.edges[1].sourceHandle = "angle:a0";
    overflow.nodes.push({ id: "extra-image", kind: "image", label: "Extra", position: { x: 900, y: 100 }, config: {} });
    assert.throws(() => validateGraph(overflow), /30 generaciones/);
});
test("one sales angle can select distinct supported formats, each counting as a request", () => {
    const graph = templateGraph("image");
    graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 300, y: 100 }, config: { angles: [
        { id: "a", text: "La misma oferta", modelId: cap.id, formatField: "aspect_ratio", format: "1:1", additionalFormats: [{ formatField: "aspect_ratio", format: "9:16" }] },
    ] } };
    graph.edges[0].target = "angles";
    graph.edges[1].source = "angles";
    const multiCap = { ...cap, custom_fields: [{ id: "aspect_ratio", label: "Ratio", type: "select" as const, options: ["1:1", "9:16"] }] };
    assert.equal(validateGraph(graph).nodes[1].config.angles?.[0].additionalFormats?.length, 1);
    validateRunnable(graph, { [angleKey("angles", "a")]: multiCap });
    const duplicate = structuredClone(graph);
    duplicate.nodes[1].config.angles![0].additionalFormats = [{ formatField: "aspect_ratio", format: "1:1" }];
    assert.throws(() => validateGraph(duplicate), /repetido/);
    const unsupported = structuredClone(graph);
    unsupported.nodes[1].config.angles![0].additionalFormats = [{ formatField: "aspect_ratio", format: "4:3" }];
    assert.throws(() => validateRunnable(unsupported, { [angleKey("angles", "a")]: multiCap }), /no admite el formato/);
    const overflow = structuredClone(graph);
    overflow.nodes[1].config.angles = Array.from({ length: 16 }, (_, index) => ({ ...graph.nodes[1].config.angles![0], id: `a${index}` }));
    assert.throws(() => validateGraph(overflow), /30 generaciones/);
});
test("sales-angle prompts apply the selected brand only to that row and reject vector-only models", () => {
    const row = { id: "a", text: "Entrega rápida", modelId: cap.id, formatField: "aspect_ratio" as const, format: "1:1" };
    const brand = { id: crypto.randomUUID(), name: "Marca Roja", primaryColor: "#aa0000", secondaryColor: "#ffffff", accentColor: "#222222", headingFont: "Montserrat", bodyFont: "Inter", voice: "Cercana", visualRules: "Alto contraste", createdAt: 1, updatedAt: 1 };
    assert.match(anglePrompt("Un producto", row, brand), /Marca Roja/);
    assert.match(anglePrompt("Un producto", row, brand), /#aa0000/);
    assert.doesNotMatch(anglePrompt("Un producto", row), /Marca Roja/);
    assert.equal(rasterAngleModel({ ...cap, label: "Recraft Vector" }), false);
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
    const { saveWorkflow, enqueueRun, runAction, archiveWorkflow, restoreWorkflow } = await import("../src/workflows/service");
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
    await t.test("archive is reversible, rejects active runs and preserves run history", async () => {
        const { workflow, run } = await enqueue();
        await assert.rejects(archiveWorkflow(workflow.id, workflow.revision), /ejecución activa/);
        await runAction(run.id, "cancel");
        const archived = await archiveWorkflow(workflow.id, workflow.revision);
        assert.ok(archived.deletedAt);
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.workflowId, workflow.id);
        await assert.rejects(saveWorkflow({ ...workflow, name: "Overwrite" }), /papelera/);
        await assert.rejects(restoreWorkflow(workflow.id, workflow.revision), /otra pestaña/);
        const restored = await restoreWorkflow(workflow.id, archived.revision);
        assert.equal(restored.deletedAt, undefined);
        assert.equal((await saveWorkflow({ id: restored.id, revision: restored.revision, name: "Edited", graph: restored.graph })).name, "Edited");
    });
    await t.test("manual trigger completes before prompt and does not call a provider", async () => {
        const graph = blankWorkflowGraph();
        graph.nodes[1].config.text = "Manual test";
        const { run } = await enqueue(graph);
        await processWorkflowStep();
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.nodes.trigger.status, "completed");
        await processWorkflowStep();
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.nodes.prompt.value?.text, "Manual test");
    });
    await t.test("retry requeues only a failed angle that was never accepted by its provider", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 340, y: 120 }, config: { angles: [{ id: "a", text: "Oferta", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" }] } };
        graph.edges[0].target = "angles";
        graph.edges[1].source = "angles";
        const { run } = await enqueue(graph);
        await store.transaction(docs => {
            const current = docs.get(`run:${run.id}`) as WorkflowRun;
            current.status = "failed";
            current.nodes.angles = { status: "failed", activeAngleId: "a", angles: { a: { status: "failed" } } };
        });
        const retried = await runAction(run.id, "retry", "angles");
        assert.equal(retried.nodes.angles.status, "pending");
        assert.equal(retried.nodes.angles.angles?.a.status, "pending");
        await runAction(run.id, "cancel");
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
    await t.test("repeater produces one request and saved result per angle, including individual outputs", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 300, y: 120 }, config: { angles: [
            { id: "a", text: "Tiempo", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
            { id: "b", text: "Calidad", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
            { id: "c", text: "Confianza", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
        ] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        graph.nodes.push({ id: "single", kind: "output", label: "Primero", position: { x: 700, y: 320 }, config: { valueKind: "image" } });
        graph.edges.push({ id: "single-edge", source: "angles", sourceHandle: "angle:a", target: "single", targetHandle: "input" });
        const caps = Object.fromEntries(graph.nodes[1].config.angles!.map(angle => [angleKey("angles", angle.id), cap]));
        const { run } = await enqueue(graph, caps);
        const requests: string[] = [];
        let output = 0;
        const generator: GenerationProvider = { id: "openrouter", async submit(request) {
            requests.push(request.params.prompt);
            return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] };
        }, async poll() { throw new Error("unexpected poll"); } };
        for (let i = 0; i < 6; i++) await processWorkflowStep({ provider: () => generator, persist: async () => [`angle-asset-${++output}`] });
        const done = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(done?.status, "completed");
        assert.equal(requests.length, 3);
        assert.ok(requests.every(prompt => prompt.includes("Fotografía editorial")));
        assert.deepEqual(done?.nodes.angles.value?.assetIds, ["angle-asset-1", "angle-asset-2", "angle-asset-3"]);
        assert.deepEqual(done?.nodes.single.value?.assetIds, ["angle-asset-1"]);
        assert.deepEqual(done?.nodes.output.value?.assetIds, ["angle-asset-1", "angle-asset-2", "angle-asset-3"]);
        assert.equal(JSON.stringify(publicRun(done!)).includes('"angleContexts"'), false);
    });
    await t.test("one angle generates every selected format and adapts from the first image", async () => {
        const graph = templateGraph("image");
        const angle = { id: "a", text: "Una oferta", modelId: cap.id, formatField: "aspect_ratio" as const, format: "1:1", additionalFormats: [{ formatField: "aspect_ratio" as const, format: "9:16" }] };
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 340, y: 120 }, config: { angles: [angle] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles"; graph.edges[1].sourceHandle = "angle:a";
        const multiCap = { ...cap, custom_fields: [{ id: "aspect_ratio", label: "Ratio", type: "select" as const, options: ["1:1", "9:16"] }] };
        const { run } = await enqueue(graph, { [angleKey("angles", "a")]: multiCap });
        const requests: Array<{ format: string | undefined; reference: string | undefined; prompt: string }> = [];
        const provider: GenerationProvider = { id: "openrouter", async submit(request) {
            requests.push({ format: request.params.aspect_ratio, reference: request.media.images?.start_image, prompt: request.params.prompt });
            return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }], usage: { costUsd: 0.02 } };
        }, async poll() { throw new Error("unexpected poll"); } };
        let saved = 0;
        const deps = { provider: () => provider, persist: async () => [`format-asset-${++saved}`], reference: async (id: string) => {
            assert.equal(id, "format-asset-1");
            return "data:image/png;base64,base";
        } };
        for (let i = 0; i < 4; i++) await processWorkflowStep(deps);
        assert.deepEqual(requests.map(request => request.format), ["1:1", "9:16"]);
        assert.equal(requests[0].reference, undefined);
        assert.equal(requests[1].reference, "data:image/png;base64,base");
        assert.match(requests[1].prompt, /misma pieza creativa/);
        const done = (await store.read<WorkflowRun>(`run:${run.id}`))!;
        assert.equal(done.status, "completed");
        assert.deepEqual(done.nodes.angles.angles?.a.value?.assetIds, ["format-asset-1", "format-asset-2"]);
        assert.deepEqual(done.nodes.output.value?.assetIds, ["format-asset-1", "format-asset-2"]);
        assert.deepEqual(angleFormats(angle).map(format => done.nodes.angles.angles?.a.formats?.[angleFormatKey(format)]?.status), ["completed", "completed"]);
        const usage = (await import("../src/billing/store")).billingStore();
        assert.equal((await usage.summary()).recent.filter(record => String(record.id).startsWith(`workflow:${run.id}:angles:a`)).length, 2);
        assert.equal(JSON.stringify(publicRun(done)).includes('"operation"'), false);
    });
    await t.test("asynchronous multi-format requests poll once each without exposing provider operations", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 340, y: 120 }, config: { angles: [{ id: "a", text: "Producto", modelId: cap.id, formatField: "aspect_ratio", format: "1:1", additionalFormats: [{ formatField: "aspect_ratio", format: "9:16" }] }] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        const multiCap = { ...cap, custom_fields: [{ id: "aspect_ratio", label: "Ratio", type: "select" as const, options: ["1:1", "9:16"] }] };
        const { run } = await enqueue(graph, { [angleKey("angles", "a")]: multiCap });
        let submits = 0, polls = 0, saved = 0;
        const provider: GenerationProvider = { id: "openrouter", async submit() {
            return { status: "CREATED", providerTaskId: `job-${++submits}`, operation: { job: submits } };
        }, async poll() { polls++; return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] }; } };
        const deps = { provider: () => provider, persist: async () => [`saved-${++saved}`], reference: async () => "data:image/png;base64,base" };
        await processWorkflowStep(deps); // prompt
        await processWorkflowStep(deps); // first submission
        const waiting = (await store.read<WorkflowRun>(`run:${run.id}`))!;
        assert.equal(waiting.nodes.angles.status, "polling");
        assert.equal(JSON.stringify(publicRun(waiting)).includes('"operation"'), false);
        await store.transaction(docs => { (docs.get(`run:${run.id}`) as WorkflowRun).nodes.angles.nextPollAt = 0; });
        await processWorkflowStep(deps); // first poll
        await processWorkflowStep(deps); // second submission
        await store.transaction(docs => { (docs.get(`run:${run.id}`) as WorkflowRun).nodes.angles.nextPollAt = 0; });
        await processWorkflowStep(deps); // second poll
        await processWorkflowStep(deps); // output
        const done = (await store.read<WorkflowRun>(`run:${run.id}`))!;
        assert.equal(done.status, "completed");
        assert.deepEqual(done.nodes.output.value?.assetIds, ["saved-1", "saved-2"]);
        assert.equal(submits, 2); assert.equal(polls, 2);
    });
    await t.test("a later format can retry before submission without regenerating the completed format", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 340, y: 120 }, config: { angles: [{ id: "a", text: "Producto", modelId: cap.id, formatField: "aspect_ratio", format: "1:1", additionalFormats: [{ formatField: "aspect_ratio", format: "9:16" }] }] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        const multiCap = { ...cap, custom_fields: [{ id: "aspect_ratio", label: "Ratio", type: "select" as const, options: ["1:1", "9:16"] }] };
        const { run } = await enqueue(graph, { [angleKey("angles", "a")]: multiCap });
        let submits = 0, references = 0, saved = 0;
        const generator: GenerationProvider = { id: "openrouter", async submit() { submits++; return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] }; }, async poll() { throw new Error("unexpected poll"); } };
        const deps = { provider: () => generator, persist: async () => [`saved-${++saved}`], reference: async () => {
            if (++references === 1) throw new WorkflowError("Referencia temporalmente no disponible");
            return "data:image/png;base64,base";
        } };
        await processWorkflowStep(deps); // prompt
        await processWorkflowStep(deps); // first format
        await processWorkflowStep(deps); // reference fails before second submission
        const failed = (await store.read<WorkflowRun>(`run:${run.id}`))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.nodes.angles.angles?.a.formats?.["aspect_ratio:1:1"].status, "completed");
        assert.equal(publicRun(failed).nodes.angles.canRetry, true);
        assert.equal(submits, 1);
        await runAction(run.id, "retry", "angles");
        await processWorkflowStep(deps); // second format only
        await processWorkflowStep(deps); // output
        const done = (await store.read<WorkflowRun>(`run:${run.id}`))!;
        assert.equal(done.status, "completed");
        assert.equal(submits, 2);
        assert.deepEqual(done.nodes.angles.value?.assetIds, ["saved-1", "saved-2"]);
    });
    await t.test("repeater preserves completed angles when a later provider request becomes uncertain", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 300, y: 120 }, config: { angles: [
            { id: "first", text: "Beneficio", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
            { id: "second", text: "Oferta", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
        ] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        const caps = { [angleKey("angles", "first")]: cap, [angleKey("angles", "second")]: cap };
        const { run } = await enqueue(graph, caps);
        let calls = 0;
        const uncertain: GenerationProvider = { id: "openrouter", async submit() {
            calls++;
            if (calls === 2) throw new Error("upstream request was interrupted");
            return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] };
        }, async poll() { throw new Error("unexpected poll"); } };
        for (let i = 0; i < 3; i++) await processWorkflowStep({ provider: () => uncertain, persist: async () => ["saved-first"] });
        const interrupted = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(interrupted?.status, "review");
        assert.equal(interrupted?.nodes.angles.angles?.first.status, "completed");
        assert.deepEqual(interrupted?.nodes.angles.value?.assetIds, ["saved-first"]);
        assert.equal(calls, 2);
        assert.equal(await processWorkflowStep({ provider: () => uncertain }), false);
        assert.equal(publicRun(interrupted!).nodes.angles.canRetry, false);
    });
    await t.test("repeater crash after submitting does not send the same angle twice", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 300, y: 120 }, config: { angles: [
            { id: "first", text: "Beneficio", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
        ] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        const { run } = await enqueue(graph, { [angleKey("angles", "first")]: cap });
        await processWorkflowStep(deps);
        await store.transaction(docs => {
            const current = docs.get(`run:${run.id}`) as WorkflowRun;
            current.nodes.angles.status = "submitting";
            current.nodes.angles.activeAngleId = "first";
            current.nodes.angles.angles!.first.status = "submitting";
            current.leaseOwner = "crashed-worker"; current.leaseUntil = 0;
        });
        assert.equal(await processWorkflowStep(deps), false);
        const paused = await store.read<WorkflowRun>(`run:${run.id}`);
        assert.equal(paused?.nodes.angles.status, "review");
        assert.equal(paused?.nodes.angles.angles?.first.status, "review");
    });
    await t.test("repeater resumes a known provider task by polling without resubmission", async () => {
        const graph = templateGraph("image");
        graph.nodes[1] = { id: "angles", kind: "salesAngles", label: "Ángulos", position: { x: 300, y: 120 }, config: { angles: [
            { id: "first", text: "Beneficio", modelId: cap.id, formatField: "aspect_ratio", format: "1:1" },
        ] } };
        graph.edges[0].target = "angles"; graph.edges[1].source = "angles";
        const { run } = await enqueue(graph, { [angleKey("angles", "first")]: cap });
        let submitted = 0, polled = 0;
        const asyncProvider: GenerationProvider = { id: "openrouter", async submit() {
            submitted++;
            return { status: "CREATED", operation: { task: "known" }, providerTaskId: "known" };
        }, async poll() {
            polled++;
            return { status: "COMPLETED", assets: [{ data: new Uint8Array([1]) }] };
        } };
        const pipeline = { provider: () => asyncProvider, persist: async () => ["saved-known"] };
        await processWorkflowStep(pipeline); await processWorkflowStep(pipeline);
        await store.transaction(docs => {
            const current = docs.get(`run:${run.id}`) as WorkflowRun;
            current.nodes.angles.status = "review";
            current.nodes.angles.angles!.first.status = "review";
            current.status = "review";
        });
        assert.equal(publicRun((await store.read<WorkflowRun>(`run:${run.id}`))!).nodes.angles.canResume, true);
        await runAction(run.id, "resume", "angles");
        await processWorkflowStep(pipeline); await processWorkflowStep(pipeline);
        assert.equal((await store.read<WorkflowRun>(`run:${run.id}`))?.status, "completed");
        assert.equal(submitted, 1); assert.equal(polled, 1);
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
