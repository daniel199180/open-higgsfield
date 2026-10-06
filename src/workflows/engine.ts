import "server-only";
import crypto from "node:crypto";
import type { CanonicalMediaInputs } from "@/models/canonical";
import { resolveProvider } from "@/providers/registry";
import type { GenerationProvider } from "@/providers/types";
import { publicErrorMessage } from "@/lib/public-error";
import { workflowStore, type Documents } from "./store";
import { event } from "./service";
import { canonicalParams } from "./validation";
import { persistGeneratedAssets, referenceValue } from "./assets";
import { WorkflowError, type WorkflowRun, type NodeRun, type NodeValue } from "./types";
import { trackedSubmit } from "@/billing/tracking";
import { billingStore } from "@/billing/store";
import { UsageReportedError } from "@/billing/usage";

const LEASE_MS = 60_000;
export function reconcile(run: WorkflowRun) {
    if (run.cancelRequested) { run.status = "cancelled"; return; }
    const states = Object.values(run.nodes).map(n => n.status);
    run.status = states.includes("review") ? "review" : states.includes("failed") ? "failed"
        : states.every(s => s === "completed") ? "completed"
        : states.includes("approval") && !states.some(s => ["preparing", "submitting", "polling"].includes(s)) ? "approval" : "running";
}

export function claimStep(docs: Documents, owner: string, now = Date.now()): { run: WorkflowRun; nodeId: string } | undefined {
    const runs = [...docs.entries()].filter(([key]) => key.startsWith("run:")).map(([, value]) => value as WorkflowRun).sort((a, b) => a.createdAt - b.createdAt);
    // Single global generation at a time for predictable spending, across workers.
    if (runs.some(r => r.leaseOwner && r.leaseUntil > now)) return;
    for (const run of runs) {
        if (run.leaseOwner && run.leaseUntil <= now) {
            for (const node of Object.values(run.nodes)) {
                if (node.status === "submitting") {
                    node.status = "review";
                    node.error = "La conexión se interrumpió durante el envío. Revisa el historial del proveedor antes de iniciar otra ejecución; no se repetirá automáticamente.";
                    event(run, node.error);
                } else if (node.status === "preparing") node.status = run.cancelRequested ? "cancelled" : "pending";
            }
            run.leaseOwner = undefined; run.leaseUntil = undefined; reconcile(run);
        }
        if (!["queued", "running", "approval", "cancelled"].includes(run.status)) continue;
        const node = run.graph.nodes.find(n => {
            const state = run.nodes[n.id];
            if (state.status === "polling") return (state.nextPollAt ?? 0) <= now;
            return !run.cancelRequested && state.status === "pending" && run.graph.edges.filter(e => e.target === n.id).every(e => run.nodes[e.source].status === "completed");
        });
        if (!node) { reconcile(run); continue; }
        run.leaseOwner = owner; run.leaseUntil = now + LEASE_MS;
        const state = run.nodes[node.id];
        if (state.status !== "polling") { state.status = "preparing"; state.startedAt = now; }
        if (!run.cancelRequested) run.status = "running";
        event(run, state.status === "polling" ? "Consultando el resultado." : "Preparando bloque.", node.id);
        return { run, nodeId: node.id };
    }
}

type Dependencies = {
    provider?: (run: WorkflowRun, nodeId: string) => GenerationProvider;
    persist?: typeof persistGeneratedAssets;
    reference?: typeof referenceValue;
};
export async function processWorkflowStep(deps: Dependencies = {}): Promise<boolean> {
    const store = workflowStore(), owner = crypto.randomUUID();
    const claim = await store.transaction(docs => claimStep(docs, owner));
    if (!claim) return false;
    const { run, nodeId } = claim;
    const node = run.graph.nodes.find(n => n.id === nodeId)!;
    const previous = run.nodes[nodeId];
    const mutate = (fn: (current: WorkflowRun, state: NodeRun) => void) => store.transaction(docs => {
        const current = docs.get(`run:${run.id}`) as WorkflowRun;
        if (current.leaseOwner !== owner) return false;
        fn(current, current.nodes[nodeId]); current.updatedAt = Date.now();
        return true;
    });
    const heartbeat = setInterval(() => { void mutate(current => { current.leaseUntil = Date.now() + LEASE_MS; }).catch(() => undefined); }, 15_000);
    heartbeat.unref();
    const complete = async (value: NodeValue, approval = false) => mutate((current, state) => {
        state.value = value; state.status = approval ? "approval" : "completed"; state.finishedAt = approval ? undefined : Date.now(); state.error = undefined;
        event(current, approval ? "Revisa el resultado y aprueba para continuar." : "Bloque completado.", nodeId);
    });
    let submitted = previous.status === "polling";
    try {
        const inputs = run.graph.edges.filter(e => e.target === nodeId);
        const valueAt = (handle: string) => run.nodes[inputs.find(e => e.targetHandle === handle)?.source ?? ""]?.value;
        if (node.kind === "prompt") await complete({ kind: "text", text: node.config.text ?? "" });
        else if (node.kind === "asset") await complete({ kind: "image", assetIds: [node.config.assetId!] });
        else if (node.kind === "approval" || node.kind === "output") {
            const input = valueAt("input");
            if (!input) throw new WorkflowError("Falta el resultado del bloque anterior.");
            await complete(input, node.kind === "approval" && !run.cancelRequested);
        } else {
            const cap = run.capabilities[nodeId];
            const provider = deps.provider?.(run, nodeId) ?? resolveProvider(cap).provider;
            if (previous.status === "polling") {
                if (Date.now() - (previous.startedAt ?? run.createdAt) > 30 * 60_000) throw new WorkflowError("Se agotó el tiempo de seguimiento. Puedes volver a consultar sin generar otra vez.");
                const result = await provider.poll({ mediaType: node.kind, providerModelId: cap.provider_model_id ?? cap.id, operation: previous.operation });
                await billingStore().begin({ id: `workflow:${run.id}:${nodeId}`, source: "workflow", provider: provider.id, connection: cap.provider_connection_id ?? "environment", model: cap.provider_model_id ?? cap.id, label: cap.label, media: node.kind, created: new Date(previous.startedAt ?? run.createdAt).toISOString(), status: result.status });
                await billingStore().update(`workflow:${run.id}:${nodeId}`, result.status, result.usage);
                if (result.status === "COMPLETED") await complete({ kind: node.kind, assetIds: await (deps.persist ?? persistGeneratedAssets)(result.assets, node.kind) });
                else if (result.status === "CREATED" || result.status === "IN_PROGRESS") await mutate((_current, state) => {
                    if (result.operation !== undefined) state.operation = result.operation;
                    state.nextPollAt = Date.now() + 10_000; state.pollErrors = 0; state.error = undefined;
                });
                else await mutate((current, state) => { state.status = "failed"; state.error = publicErrorMessage("error" in result ? result.error : ""); event(current, state.error, nodeId); });
            } else {
                const prompt = valueAt("prompt")?.text ?? node.config.text ?? "";
                const params = canonicalParams(node, cap, prompt);
                const media: CanonicalMediaInputs = {};
                for (const edge of inputs.filter(e => e.targetHandle.startsWith("slot:"))) {
                    const input = run.nodes[edge.source].value;
                    const slot = cap.media_slots.find(s => `slot:${s.id}` === edge.targetHandle);
                    if (!input?.assetIds?.[0] || !slot) throw new WorkflowError("Imagen de entrada no disponible.");
                    media.images ??= {};
                    media.images[slot.id] = await (deps.reference ?? referenceValue)(input.assetIds[0], cap.provider ?? "freepik", slot.accept);
                }
                // Commit the uncertain boundary BEFORE any billable provider request.
                let allowed = false;
                const owned = await mutate((current, state) => {
                    if (current.cancelRequested) { state.status = "cancelled"; return; }
                    allowed = true; state.status = "submitting";
                    event(current, "Generando con el proveedor. No cierres el servidor; puedes cerrar esta pestaña.", nodeId);
                });
                if (!owned || !allowed) return true;
                submitted = true;
                const result = await trackedSubmit(`workflow:${run.id}:${nodeId}`, "workflow", provider, { mediaType: node.kind, modelId: cap.id, providerModelId: cap.provider_model_id ?? cap.id, providerMode: cap.provider_mode, connectionId: cap.provider_connection_id, capabilities: cap, params, media });
                if (result.status === "COMPLETED") await complete({ kind: node.kind, assetIds: await (deps.persist ?? persistGeneratedAssets)(result.assets, node.kind) });
                else await mutate((current, state) => {
                    state.status = "polling"; state.operation = result.operation; state.providerTaskId = result.providerTaskId; state.nextPollAt = Date.now() + 3000;
                    event(current, "El proveedor aceptó la tarea. Esperando resultado.", nodeId);
                });
            }
        }
    } catch (error) {
        if (node.kind === "image" || node.kind === "video") await billingStore().update(`workflow:${run.id}:${nodeId}`, "UNCONFIRMED", error instanceof UsageReportedError ? error.usage : undefined).catch(() => undefined);
        await mutate((current, state) => {
            const safe = error instanceof WorkflowError ? error.message : publicErrorMessage(error);
            if (previous.status === "polling" && !(error instanceof WorkflowError) && (state.pollErrors ?? 0) < 4) {
                state.pollErrors = (state.pollErrors ?? 0) + 1;
                state.nextPollAt = Date.now() + 15_000 * state.pollErrors;
                state.error = `Reintentando consulta: ${safe}`;
            } else {
                state.status = submitted ? "review" : "failed";
                state.error = submitted ? `${safe}. No se reenviará la generación. Revisa el proveedor antes de volver a generar.` : safe;
                event(current, state.error, nodeId);
            }
        });
    } finally {
        clearInterval(heartbeat);
        await mutate(current => { current.leaseOwner = undefined; current.leaseUntil = undefined; reconcile(current); });
    }
    return true;
}

const engineGlobal = globalThis as typeof globalThis & { __workflowEngine?: ReturnType<typeof setInterval>; __workflowBusy?: boolean };
export function startWorkflowEngine() {
    if (engineGlobal.__workflowEngine || process.env.NEXT_PHASE === "phase-production-build") return;
    engineGlobal.__workflowEngine = setInterval(() => {
        if (engineGlobal.__workflowBusy) return;
        engineGlobal.__workflowBusy = true;
        void processWorkflowStep().catch(() => console.warn("[workflows] Motor temporalmente no disponible; no se reenviarán solicitudes ambiguas.")).finally(() => { engineGlobal.__workflowBusy = false; });
    }, 1000);
    engineGlobal.__workflowEngine.unref();
}
