import "server-only";
import crypto from "node:crypto";
import { getCatalog } from "@/providers/catalog";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { workflowStore, type Documents } from "./store";
import { validateGraph, validateRunnable, executionGraph } from "./validation";
import { WorkflowError, type Workflow, type WorkflowRun, type WorkflowGraph, type Asset } from "./types";

export async function saveWorkflow(input: { id?: string; revision?: number; name: string; graph: WorkflowGraph }): Promise<Workflow> {
    const graph = validateGraph(input.graph);
    return workflowStore().transaction(docs => {
        const existing = input.id ? docs.get(`workflow:${input.id}`) as Workflow | undefined : undefined;
        if (input.id && !existing) throw new WorkflowError("Workflow no encontrado.", 404);
        if (existing && existing.revision !== input.revision) throw new WorkflowError("Este workflow cambió en otra pestaña. Recarga antes de guardar.", 409);
        if (!existing && [...docs.keys()].filter(k => k.startsWith("workflow:")).length >= 200) throw new WorkflowError("Límite de 200 workflows alcanzado.");
        const value: Workflow = { id: existing?.id ?? crypto.randomUUID(), name: input.name, graph, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
        docs.set(`workflow:${value.id}`, value);
        return value;
    });
}

export function event(run: WorkflowRun, message: string, nodeId?: string) {
    run.updatedAt = Date.now();
    run.events.push({ at: run.updatedAt, nodeId, message });
    run.events = run.events.slice(-200);
}

export async function prepareRun(graph: WorkflowGraph) {
    const types = new Set(graph.nodes.map(n => n.kind));
    const models = {
        image: types.has("image") ? await getCatalog("image") : [],
        video: types.has("video") ? await getCatalog("video") : [],
    };
    const capabilities: Record<string, ModelCapabilities> = {};
    for (const node of graph.nodes) {
        if (["image", "video"].includes(node.kind)) {
            const cap = models[node.kind as "image" | "video"].find(c => c.id === node.config.modelId);
            if (cap) capabilities[node.id] = cap;
        }
        if (node.kind === "asset" && node.config.assetId && !(await workflowStore().read<Asset>(`asset:${node.config.assetId}`))) throw new WorkflowError("Una imagen de entrada ya no está disponible.");
    }
    validateRunnable(graph, capabilities);
    const needsHostedReferences = graph.edges.some(e => {
        const cap = capabilities[e.target];
        return e.targetHandle.startsWith("slot:") && cap && !["openrouter", "google-ai-studio", "google-vertex", "vercel-ai-gateway"].includes(cap.provider ?? "freepik") && cap.media_slots.find(s => `slot:${s.id}` === e.targetHandle)?.accept !== "b64_only";
    });
    if (needsHostedReferences && !process.env.CLOUDINARY_URL && !(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)) throw new WorkflowError("Este proveedor necesita subir las referencias a Cloudinary. Configura el almacenamiento o usa OpenRouter, que admite imágenes locales.");
    return capabilities;
}

export function enqueueRun(docs: Documents, workflow: Workflow, graph: WorkflowGraph, capabilities: WorkflowRun["capabilities"], key: string, fingerprint: string): WorkflowRun {
    const runs = [...docs.entries()].filter(([id]) => id.startsWith("run:")).map(([, v]) => v as WorkflowRun);
    const duplicate = runs.find(run => run.requestKey === key);
    if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new WorkflowError("La clave de ejecución corresponde a otra solicitud.", 409);
        return duplicate;
    }
    if (runs.some(run => run.workflowId === workflow.id && ["queued", "running", "approval"].includes(run.status))) throw new WorkflowError("Este workflow ya tiene una ejecución activa. Ábrela en el historial antes de iniciar otra.", 409);
    if (runs.length >= 800) throw new WorkflowError("Se alcanzó el límite de historial (800 ejecuciones). Exporta y archiva antes de ampliar el almacenamiento.");
    if (runs.filter(run => ["queued", "running", "approval"].includes(run.status)).length >= 3) throw new WorkflowError("Ya hay 3 ejecuciones activas. Termina o detén una antes de continuar.", 409);
    const run: WorkflowRun = {
        id: crypto.randomUUID(), workflowId: workflow.id, revision: workflow.revision, name: workflow.name,
        graph, capabilities, requestKey: key, fingerprint, status: "queued", createdAt: Date.now(), updatedAt: Date.now(),
        nodes: Object.fromEntries(graph.nodes.map(n => [n.id, { status: "pending" }])), events: [],
    };
    event(run, "Ejecución guardada. Esperando al motor.");
    docs.set(`run:${run.id}`, run);
    return run;
}

export async function startRun(input: { workflowId: string; revision: number; key: string; targetId?: string }) {
    const store = workflowStore();
    const workflow = await store.read<Workflow>(`workflow:${input.workflowId}`);
    if (!workflow) throw new WorkflowError("Workflow no encontrado.", 404);
    if (workflow.revision !== input.revision) throw new WorkflowError("Guarda la versión actual antes de ejecutar.", 409);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([input.workflowId, input.revision, input.targetId])).digest("hex");
    const previous = (await store.list<WorkflowRun>("run:")).find(r => r.requestKey === input.key);
    if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WorkflowError("Clave de ejecución reutilizada con otro contenido.", 409);
        return previous;
    }
    const graph = executionGraph(workflow.graph, input.targetId);
    const capabilities = await prepareRun(graph);
    return store.transaction(docs => {
        if ((docs.get(`workflow:${workflow.id}`) as Workflow)?.revision !== input.revision) throw new WorkflowError("El workflow cambió. Vuelve a ejecutar la versión guardada.", 409);
        return enqueueRun(docs, workflow, graph, capabilities, input.key, fingerprint);
    });
}

export async function runAction(runId: string, action: "approve" | "cancel" | "resume", nodeId?: string) {
    return workflowStore().transaction(docs => {
        const run = docs.get(`run:${runId}`) as WorkflowRun | undefined;
        if (!run) throw new WorkflowError("Ejecución no encontrada.", 404);
        if (action === "cancel") {
            run.cancelRequested = true;
            run.status = "cancelled";
            for (const node of Object.values(run.nodes)) if (["pending", "approval", "preparing"].includes(node.status)) node.status = "cancelled";
            event(run, "Se detuvieron los pasos pendientes. El proveedor puede completar y cobrar las solicitudes ya enviadas.");
        } else if (action === "approve") {
            const node = run.nodes[nodeId ?? ""];
            if (run.cancelRequested || !node || node.status !== "approval") throw new WorkflowError("Ese bloque no está esperando aprobación.", 409);
            node.status = "completed"; node.finishedAt = Date.now(); run.status = "queued";
            event(run, "Resultado aprobado. Continuando.", nodeId);
        } else {
            // Resume status checks only; never resubmit an ambiguous generation.
            const node = run.nodes[nodeId ?? ""];
            if (run.cancelRequested || !node?.operation || node.status !== "review") throw new WorkflowError("No hay una tarea del proveedor que se pueda volver a consultar.", 409);
            node.status = "polling"; node.error = undefined; node.pollErrors = 0; node.nextPollAt = 0; node.startedAt = Date.now(); run.status = "queued";
            event(run, "Reanudando consulta del proveedor sin generar de nuevo.", nodeId);
        }
        return run;
    });
}
