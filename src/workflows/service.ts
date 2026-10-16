import "server-only";
import crypto from "node:crypto";
import { getCatalog } from "@/providers/catalog";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { getVoice } from "@/audio/store";
import { audioConnection, elevenModels } from "@/audio/provider";
import { workflowStore, type Documents } from "./store";
import { validateGraph, validateRunnable, executionGraph, canonicalParams } from "./validation";
import { WorkflowError, type Workflow, type WorkflowRun, type WorkflowGraph, type Asset } from "./types";
import type { BrandSystem } from "@/social/types";
import { brandLogoAssetIds, brandImageAssetIds } from "@/social/brand";
import { angleFormats, angleFormatKey, angleKey, anglePrompt } from "./sales-angles";
import { publicReferenceOrigin } from "@/lib/provider-input";
import { acceptsInlineImageReference } from "@/lib/image-reference";

export async function saveWorkflow(input: { id?: string; revision?: number; name: string; graph: WorkflowGraph }): Promise<Workflow> {
    const graph = validateGraph(input.graph);
    return workflowStore().transaction(docs => {
        const existing = input.id ? docs.get(`workflow:${input.id}`) as Workflow | undefined : undefined;
        if (input.id && !existing) throw new WorkflowError("Workflow no encontrado.", 404);
        if (existing?.deletedAt) throw new WorkflowError("Este workflow está en la papelera. Restáuralo antes de editarlo.", 409);
        if (existing && existing.revision !== input.revision) throw new WorkflowError("Este workflow cambió en otra pestaña. Recarga antes de guardar.", 409);
        if (!existing && [...docs.entries()].filter(([k, v]) => k.startsWith("workflow:") && !(v as Workflow).deletedAt).length >= 200) throw new WorkflowError("Límite de 200 workflows alcanzado.");
        const value: Workflow = { id: existing?.id ?? crypto.randomUUID(), name: input.name, graph, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
        docs.set(`workflow:${value.id}`, value);
        return value;
    });
}

export async function archiveWorkflow(id: string, revision: number): Promise<Workflow> {
    return workflowStore().transaction(docs => {
        const workflow = docs.get(`workflow:${id}`) as Workflow | undefined;
        if (!workflow || workflow.deletedAt) throw new WorkflowError("Workflow no encontrado.", 404);
        if (workflow.revision !== revision) throw new WorkflowError("Este workflow cambió en otra pestaña. Recarga antes de borrarlo.", 409);
        if ([...docs.entries()].some(([key, value]) => key.startsWith("run:") && (value as WorkflowRun).workflowId === id && ["queued", "running", "approval"].includes((value as WorkflowRun).status))) throw new WorkflowError("Este workflow tiene una ejecución activa. Detenla o espera a que termine antes de borrarlo.", 409);
        const archived = { ...workflow, deletedAt: Date.now(), updatedAt: Date.now(), revision: workflow.revision + 1 };
        docs.set(`workflow:${id}`, archived);
        return archived;
    });
}

export async function restoreWorkflow(id: string, revision: number): Promise<Workflow> {
    return workflowStore().transaction(docs => {
        const workflow = docs.get(`workflow:${id}`) as Workflow | undefined;
        if (!workflow?.deletedAt) throw new WorkflowError("Workflow no encontrado en la papelera.", 404);
        if (workflow.revision !== revision) throw new WorkflowError("Este workflow cambió en otra pestaña. Recarga antes de restaurarlo.", 409);
        if ([...docs.entries()].filter(([key, value]) => key.startsWith("workflow:") && !(value as Workflow).deletedAt).length >= 200) throw new WorkflowError("Límite de 200 workflows alcanzado.");
        const restored = { ...workflow, deletedAt: undefined, updatedAt: Date.now(), revision: workflow.revision + 1 };
        docs.set(`workflow:${id}`, restored);
        return restored;
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
        image: types.has("image") || types.has("salesAngles") ? await getCatalog("image") : [],
        video: types.has("video") ? await getCatalog("video") : [],
    };
    const capabilities: Record<string, ModelCapabilities> = {};
    const angleContexts: NonNullable<WorkflowRun["angleContexts"]> = {};
    for (const node of graph.nodes) {
        if (node.kind === "audio" && node.config.voiceId && node.config.modelId) {
            const voice = await getVoice(node.config.voiceId);
            if (!voice) throw new WorkflowError(`La voz de «${node.label}» ya no está disponible.`);
            if (voice.requiresVerification) throw new WorkflowError(`La voz de «${node.label}» necesita verificación en ElevenLabs.`);
            const connection = await audioConnection("elevenlabs", voice.connectionId);
            if (!(await elevenModels(connection)).some(model => model.id === node.config.modelId)) throw new WorkflowError(`El modelo de audio de «${node.label}» ya no está disponible.`);
        }
        if (["image", "video"].includes(node.kind)) {
            const cap = models[node.kind as "image" | "video"].find(c => c.id === node.config.modelId);
            if (cap) capabilities[node.id] = cap;
        }
        if (node.kind === "salesAngles") for (const angle of node.config.angles ?? []) {
            const key = angleKey(node.id, angle.id);
            const cap = models.image.find(c => c.id === angle.modelId);
            if (cap) capabilities[key] = cap;
            const brand = angle.brandId ? await workflowStore().read<BrandSystem>(`brand:${angle.brandId}`) : undefined;
            if (angle.brandId && !brand) throw new WorkflowError(`El sistema de diseño del ángulo «${angle.text}» ya no existe.`);
            const logoAssetIds = brand ? brandLogoAssetIds(brand) : [];
            const referenceAssetIds = (brand?.references ?? []).map(item => item.assetId);
            for (const id of brand ? brandImageAssetIds(brand) : []) {
                if ((await workflowStore().read<Asset>(`asset:${id}`))?.kind !== "image") throw new WorkflowError("Un logo del sistema de diseño ya no está disponible.");
            }
            if ((logoAssetIds.length || referenceAssetIds.length) && cap && !cap.media_slots.some(slot => slot.kind === "image" && !slot.required)) throw new WorkflowError(`El modelo de «${angle.text}» no admite los logos del sistema de diseño.`);
            angleContexts[key] = { prompt: anglePrompt("", angle, brand), logoAssetId: logoAssetIds[0], logoAssetIds, referenceAssetIds, referenceLabels: Object.fromEntries((brand?.references ?? []).map(item => [item.assetId, item.name])) };
            if (cap) {
                const sourceId = graph.edges.find(edge => edge.target === node.id && edge.targetHandle === "prompt")?.source;
                const source = graph.nodes.find(entry => entry.id === sourceId);
                const brief = source?.kind === "prompt" ? source.config.text : node.config.text;
                if (brief) for (const format of angleFormats(angle)) canonicalParams({ ...node, config: { params: { [format.formatField]: format.format, ...(angle.resolution ? { resolution: angle.resolution } : {}) } } }, cap, [brief, angleContexts[key].prompt].join("\n\n"));
            }
        }
        if (node.kind === "asset" && node.config.assetId && !(await workflowStore().read<Asset>(`asset:${node.config.assetId}`))) throw new WorkflowError("Una imagen de entrada ya no está disponible.");
    }
    validateRunnable(graph, capabilities);
    const needsHostedReferences = graph.edges.some(e => {
        const cap = capabilities[e.target];
        return e.targetHandle.startsWith("slot:") && cap && !acceptsInlineImageReference(cap.provider, cap.provider_model_id) && cap.media_slots.find(s => `slot:${s.id}` === e.targetHandle)?.accept !== "b64_only";
    }) || Object.entries(angleContexts).some(([key, context]) => {
        const cap = capabilities[key];
        const slot = cap?.media_slots.find(item => item.kind === "image" && !item.required);
        const [nodeId, angleId] = key.split(":");
        const angle = graph.nodes.find(node => node.id === nodeId)?.config.angles?.find(item => item.id === angleId);
        const usesReference = !!context.referenceAssetIds?.length || !!context.logoAssetIds?.length || !!context.logoAssetId || !!angle && angleFormats(angle).length > 1;
        return usesReference && !!slot && !acceptsInlineImageReference(cap.provider, cap.provider_model_id) && slot.accept !== "b64_only";
    });
    if (needsHostedReferences) {
        try { publicReferenceOrigin(); }
        catch { throw new WorkflowError("Este modelo necesita una URL HTTPS pública para sus referencias. Configura OPEN_HIGGSFIELD_APP_ORIGIN con el dominio accesible del servicio o elige un modelo que admita imágenes directas."); }
    }
    return { capabilities, angleContexts };
}

export function enqueueRun(docs: Documents, workflow: Workflow, graph: WorkflowGraph, capabilities: WorkflowRun["capabilities"], key: string, fingerprint: string, angleContexts: WorkflowRun["angleContexts"] = {}, companyId?: string): WorkflowRun {
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
        id: crypto.randomUUID(), workflowId: workflow.id, revision: workflow.revision, name: workflow.name, companyId,
        graph, capabilities, angleContexts, requestKey: key, fingerprint, status: "queued", createdAt: Date.now(), updatedAt: Date.now(),
        nodes: Object.fromEntries(graph.nodes.map(n => [n.id, { status: "pending", ...(n.kind === "salesAngles" ? { angles: Object.fromEntries((n.config.angles ?? []).map(a => [a.id, { status: "pending", formats: Object.fromEntries(angleFormats(a).map(format => [angleFormatKey(format), { status: "pending" }])) }])) } : {}) }])), events: [],
    };
    event(run, "Ejecución guardada. Esperando al motor.");
    docs.set(`run:${run.id}`, run);
    return run;
}

export async function startRun(input: { workflowId: string; revision: number; key: string; targetId?: string; companyId?: string }) {
    const store = workflowStore();
    const workflow = await store.read<Workflow>(`workflow:${input.workflowId}`);
    if (!workflow || workflow.deletedAt) throw new WorkflowError("Workflow no encontrado.", 404);
    if (workflow.revision !== input.revision) throw new WorkflowError("Guarda la versión actual antes de ejecutar.", 409);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input.companyId ? [input.workflowId, input.revision, input.targetId, input.companyId] : [input.workflowId, input.revision, input.targetId])).digest("hex");
    const previous = (await store.list<WorkflowRun>("run:")).find(r => r.requestKey === input.key);
    if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WorkflowError("Clave de ejecución reutilizada con otro contenido.", 409);
        return previous;
    }
    const graph = executionGraph(workflow.graph, input.targetId);
    const { capabilities, angleContexts } = await prepareRun(graph);
    return store.transaction(docs => {
        const current = docs.get(`workflow:${workflow.id}`) as Workflow | undefined;
        if (!current || current.deletedAt || current.revision !== input.revision) throw new WorkflowError("El workflow cambió. Vuelve a ejecutar la versión guardada.", 409);
        return enqueueRun(docs, workflow, graph, capabilities, input.key, fingerprint, angleContexts, input.companyId);
    });
}

export async function runAction(runId: string, action: "approve" | "cancel" | "resume" | "retry", nodeId?: string) {
    return workflowStore().transaction(docs => {
        const run = docs.get(`run:${runId}`) as WorkflowRun | undefined;
        if (!run) throw new WorkflowError("Ejecución no encontrada.", 404);
        if (action === "cancel") {
            run.cancelRequested = true;
            run.status = "cancelled";
            for (const node of Object.values(run.nodes)) {
                if (["pending", "approval", "preparing"].includes(node.status)) node.status = "cancelled";
                for (const angle of Object.values(node.angles ?? {})) {
                    if (["pending", "preparing"].includes(angle.status)) angle.status = "cancelled";
                    for (const format of Object.values(angle.formats ?? {})) if (["pending", "preparing"].includes(format.status)) format.status = "cancelled";
                }
            }
            event(run, "Se detuvieron los pasos pendientes. El proveedor puede completar y cobrar las solicitudes ya enviadas.");
        } else if (action === "approve") {
            const node = run.nodes[nodeId ?? ""];
            if (run.cancelRequested || !node || node.status !== "approval") throw new WorkflowError("Ese bloque no está esperando aprobación.", 409);
            node.status = "completed"; node.finishedAt = Date.now(); run.status = "queued";
            event(run, "Resultado aprobado. Continuando.", nodeId);
        } else if (action === "resume") {
            // Resume status checks only; never resubmit an ambiguous generation.
            const node = run.nodes[nodeId ?? ""];
            const angle = node?.activeAngleId ? node.angles?.[node.activeAngleId] : undefined;
            const format = node?.activeFormatKey ? angle?.formats?.[node.activeFormatKey] : angle;
            if (run.cancelRequested || !(format?.operation ?? node?.operation) || node?.status !== "review") throw new WorkflowError("No hay una tarea del proveedor que se pueda volver a consultar.", 409);
            node.status = "polling"; node.error = undefined; node.pollErrors = 0; node.nextPollAt = 0; node.startedAt = Date.now(); run.status = "queued";
            if (angle) { angle.status = "polling"; angle.error = undefined; angle.pollErrors = 0; angle.startedAt = Date.now(); }
            if (format && format !== angle) { format.status = "polling"; format.error = undefined; format.pollErrors = 0; format.startedAt = Date.now(); }
            event(run, "Reanudando consulta del proveedor sin generar de nuevo.", nodeId);
        } else {
            const node = run.nodes[nodeId ?? ""];
            const angle = node?.activeAngleId ? node.angles?.[node.activeAngleId] : undefined;
            const format = node?.activeFormatKey ? angle?.formats?.[node.activeFormatKey] : angle;
            if (run.cancelRequested || !angle || !format || node.status !== "failed" || format.status !== "failed" || format.operation || format.providerTaskId) throw new WorkflowError("Solo se puede reintentar un formato que falló antes de ser aceptado por el proveedor.", 409);
            format.status = "pending"; format.error = undefined; angle.status = "pending"; angle.error = undefined; node.status = "pending"; node.error = undefined; node.activeAngleId = undefined; node.activeFormatKey = undefined; run.status = "queued";
            event(run, "Ángulo pendiente de reintento. Se enviará una nueva solicitud.", nodeId);
        }
        return run;
    });
}
