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
import { angleFormats, angleFormatKey, angleKey } from "./sales-angles";
import { getVoice } from "@/audio/store";
import { audioConnection, speakWithVoice } from "@/audio/provider";
import { referenceSheetValue } from "@/social/references";

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
                    if (node.activeAngleId && node.angles?.[node.activeAngleId]) {
                        node.angles[node.activeAngleId].status = "review";
                        node.angles[node.activeAngleId].error = node.error;
                        const format = node.activeFormatKey && node.angles[node.activeAngleId].formats?.[node.activeFormatKey];
                        if (format) { format.status = "review"; format.error = node.error; }
                    }
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
    let selectedAngleId: string | undefined;
    let selectedFormatKey: string | undefined;
    try {
        const inputs = run.graph.edges.filter(e => e.target === nodeId);
        const valueAt = (handle: string): NodeValue | undefined => {
            const edge = inputs.find(e => e.targetHandle === handle);
            if (!edge) return undefined;
            const source = run.nodes[edge.source];
            return edge.sourceHandle?.startsWith("angle:") ? source?.angles?.[edge.sourceHandle.slice(6)]?.value : source?.value;
        };
        if (node.kind === "manualTrigger") await complete({ kind: "text", text: "Iniciado manualmente" });
        else if (node.kind === "prompt") await complete({ kind: "text", text: node.config.text ?? "" });
        else if (node.kind === "asset") await complete({ kind: "image", assetIds: [node.config.assetId!] });
        else if (node.kind === "audio") {
            const voice = await getVoice(node.config.voiceId ?? "");
            if (!voice) throw new WorkflowError("La voz guardada no está disponible.");
            if (voice.requiresVerification) throw new WorkflowError("Esta voz requiere verificación en ElevenLabs.");
            const connection = await audioConnection("elevenlabs", voice.connectionId);
            const spokenText = (valueAt("prompt")?.text ?? node.config.text ?? "").trim();
            if (!spokenText || spokenText.length > 3000) throw new WorkflowError("El texto de audio debe tener entre 1 y 3000 caracteres.");
            let allowed = false;
            const owned = await mutate((current, state) => {
                if (current.cancelRequested) { state.status = "cancelled"; return; }
                allowed = true; state.status = "submitting";
                event(current, "Generando locución. No se reenviará automáticamente si la conexión se interrumpe.", nodeId);
            });
            if (!owned || !allowed) return true;
            submitted = true;
            const result = await speakWithVoice(connection, voice, spokenText, node.config.modelId!, { id: `workflow:${run.id}:${nodeId}`, source: "workflow" });
            await complete({ kind: "audio", assetIds: [result.assetId] });
        }
        else if (node.kind === "approval" || node.kind === "output") {
            const input = valueAt("input");
            if (!input) throw new WorkflowError("Falta el resultado del bloque anterior.");
            await complete(input, node.kind === "approval" && !run.cancelRequested);
        } else if (node.kind === "salesAngles") {
            const angle = (node.config.angles ?? []).find(entry => {
                if (previous.status === "polling") return entry.id === previous.activeAngleId;
                const state = previous.angles?.[entry.id];
                return angleFormats(entry).some(format => (state?.formats?.[angleFormatKey(format)] ?? state)?.status === "pending");
            });
            if (!angle) throw new WorkflowError("No hay formatos pendientes para este bloque.");
            selectedAngleId = angle.id;
            const formats = angleFormats(angle);
            const format = previous.status === "polling"
                ? formats.find(entry => angleFormatKey(entry) === previous.activeFormatKey) ?? formats[0]
                : formats.find(entry => (previous.angles?.[angle.id]?.formats?.[angleFormatKey(entry)] ?? previous.angles?.[angle.id])?.status === "pending");
            if (!format) throw new WorkflowError("No hay un formato pendiente para este ángulo.");
            selectedFormatKey = angleFormatKey(format);
            const key = angleKey(nodeId, angle.id);
            const cap = run.capabilities[key];
            const provider = deps.provider?.(run, key) ?? resolveProvider(cap).provider;
            const primaryKey = angleFormatKey(formats[0]);
            const billId = `workflow:${run.id}:${key}${selectedFormatKey === primaryKey ? "" : `:${selectedFormatKey}`}`;
            const completeFormat = async (ids: string[]) => mutate((current, state) => {
                const angleState = state.angles![angle.id];
                const item = angleState.formats?.[selectedFormatKey!] ?? angleState;
                item.value = { kind: "image", assetIds: ids }; item.status = "completed"; item.finishedAt = Date.now(); item.error = undefined;
                const formatDone = formats.every(entry => (angleState.formats?.[angleFormatKey(entry)] ?? angleState).status === "completed");
                angleState.value = { kind: "image", assetIds: formats.flatMap(entry => (angleState.formats?.[angleFormatKey(entry)] ?? angleState).value?.assetIds ?? []) };
                angleState.status = formatDone ? "completed" : "pending"; angleState.error = undefined;
                if (formatDone) angleState.finishedAt = Date.now();
                const allDone = (node.config.angles ?? []).every(entry => state.angles?.[entry.id]?.status === "completed");
                state.value = { kind: "image", assetIds: (node.config.angles ?? []).flatMap(entry => state.angles?.[entry.id]?.value?.assetIds ?? []) };
                state.status = allDone ? "completed" : "pending";
                state.activeAngleId = undefined; state.activeFormatKey = undefined; state.operation = undefined; state.nextPollAt = undefined; state.error = undefined;
                if (allDone) state.finishedAt = Date.now();
                event(current, `Formato ${format.format} de «${angle.text}» completado (${Object.values(state.angles ?? {}).reduce((total, item) => total + (item.formats ? Object.values(item.formats).filter(entry => entry.status === "completed").length : Number(item.status === "completed")), 0)}/${(node.config.angles ?? []).reduce((total, entry) => total + angleFormats(entry).length, 0)}).`, nodeId);
            });
            if (previous.status === "polling") {
                const angleState = previous.angles?.[angle.id];
                const item = angleState?.formats?.[selectedFormatKey] ?? angleState;
                if (Date.now() - (item?.startedAt ?? run.createdAt) > 30 * 60_000) throw new WorkflowError("Se agotó el tiempo de seguimiento. Puedes volver a consultar sin generar otra vez.");
                const result = await provider.poll({ mediaType: "image", providerModelId: cap.provider_model_id ?? cap.id, operation: item?.operation });
                await billingStore().begin({ id: billId, source: "workflow", provider: provider.id, connection: cap.provider_connection_id ?? "environment", model: cap.provider_model_id ?? cap.id, label: cap.label, media: "image", created: new Date(item?.startedAt ?? run.createdAt).toISOString(), status: result.status });
                await billingStore().update(billId, result.status, result.usage);
                if (result.status === "COMPLETED") await completeFormat(await (deps.persist ?? persistGeneratedAssets)(result.assets, "image"));
                else if (result.status === "CREATED" || result.status === "IN_PROGRESS") await mutate((_current, state) => {
                    const currentAngle = state.angles![angle.id];
                    const currentItem = currentAngle.formats?.[selectedFormatKey!] ?? currentAngle;
                    currentItem.operation = result.operation ?? item?.operation;
                    state.nextPollAt = Date.now() + 10_000; currentItem.pollErrors = 0; state.error = undefined;
                });
                else await mutate((current, state) => {
                    const currentAngle = state.angles![angle.id];
                    const currentItem = currentAngle.formats?.[selectedFormatKey!] ?? currentAngle;
                    state.status = "failed"; currentAngle.status = "failed"; currentItem.status = "failed";
                    state.error = publicErrorMessage("error" in result ? result.error : ""); currentAngle.error = state.error; currentItem.error = state.error;
                    event(current, `Falló formato ${format.format} de «${angle.text}»: ${state.error}`, nodeId);
                });
            } else {
                const brief = valueAt("prompt")?.text ?? node.config.text ?? "";
                const baseAssetId = previous.angles?.[angle.id]?.formats?.[primaryKey]?.value?.assetIds?.[0];
                const referenceSlot = cap.media_slots.find(slot => slot.kind === "image" && !slot.required);
                const useBaseReference = selectedFormatKey !== primaryKey && !!baseAssetId && !!referenceSlot;
                const context = run.angleContexts?.[key];
                const logoAssetIds = context?.logoAssetIds?.length ? context.logoAssetIds : context?.logoAssetId ? [context.logoAssetId] : [];
                const prompt = [brief, run.angleContexts?.[key]?.prompt ?? angle.text,
                    `Formato de salida: ${format.format}. Recompón la pieza para este tamaño; mantén legibles los textos, el logo y la oferta.`,
                    useBaseReference ? "Usa la imagen de referencia como la misma pieza creativa: conserva sujetos, estilo, texto y elementos clave; adapta únicamente la distribución al nuevo formato, sin estirar ni recortar contenido importante." : "",
                    logoAssetIds.length ? "Los logos de referencia son los originales de la marca; inclúyelos sin alterar su identidad. Si se adjunta una hoja de referencias, no copies sus divisiones ni márgenes." : "",
                ].filter(Boolean).join("\n\n");
                const values = { [format.formatField]: format.format, ...(angle.resolution ? { resolution: angle.resolution } : {}) };
                const params = canonicalParams({ ...node, config: { params: values } }, cap, prompt);
                if (cap.provider === "openrouter") params.field_values = { ...params.field_values, n: 1 };
                const media: CanonicalMediaInputs = {};
                if (referenceSlot) {
                    const referenceIds = [...(useBaseReference ? [baseAssetId] : []), ...logoAssetIds];
                    if (referenceIds.length > 0) {
                        const providerId = cap.provider ?? "openrouter";
                        const resolve = deps.reference ?? referenceValue;
                        const references = referenceSlot.multiple
                            ? await Promise.all(referenceIds.map(id => resolve(id, providerId, referenceSlot.accept)))
                            : [referenceIds.length === 1
                                ? await resolve(referenceIds[0], providerId, referenceSlot.accept)
                                : await referenceSheetValue(referenceIds, providerId, referenceSlot.accept)];
                        media.images = { [referenceSlot.id]: referenceSlot.multiple ? references as unknown as string : references[0] };
                    }
                }
                let allowed = false;
                const owned = await mutate((current, state) => {
                    if (current.cancelRequested) { state.status = "cancelled"; return; }
                    allowed = true; state.status = "submitting"; state.activeAngleId = angle.id; state.activeFormatKey = selectedFormatKey;
                    const currentAngle = state.angles![angle.id];
                    const item = currentAngle.formats?.[selectedFormatKey!] ?? currentAngle;
                    currentAngle.status = "submitting"; item.status = "submitting"; item.startedAt = Date.now();
                    event(current, `Generando «${angle.text}» en ${format.format} con ${cap.label}.`, nodeId);
                });
                if (!owned || !allowed) return true;
                submitted = true;
                const result = await trackedSubmit(billId, "workflow", provider, { mediaType: "image", modelId: cap.id, providerModelId: cap.provider_model_id ?? cap.id, providerMode: cap.provider_mode, connectionId: cap.provider_connection_id, capabilities: cap, params, media });
                if (result.status === "COMPLETED") await completeFormat(await (deps.persist ?? persistGeneratedAssets)(result.assets, "image"));
                else await mutate((current, state) => {
                    state.status = "polling"; state.nextPollAt = Date.now() + 3000;
                    const currentAngle = state.angles![angle.id];
                    const item = currentAngle.formats?.[selectedFormatKey!] ?? currentAngle;
                    currentAngle.status = "polling"; item.status = "polling"; item.operation = result.operation; item.providerTaskId = result.providerTaskId;
                    event(current, `El proveedor aceptó «${angle.text}» en ${format.format}. Esperando resultado.`, nodeId);
                });
            }
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
                    const input = valueAt(edge.targetHandle);
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
        if (node.kind === "image" || node.kind === "video" || node.kind === "salesAngles") {
            const activeId = node.kind === "salesAngles" ? selectedAngleId : undefined;
            const angle = activeId ? node.config.angles?.find(item => item.id === activeId) : undefined;
            const primaryKey = angle ? angleFormatKey(angleFormats(angle)[0]) : undefined;
            const suffix = activeId ? `:${activeId}${selectedFormatKey && selectedFormatKey !== primaryKey ? `:${selectedFormatKey}` : ""}` : "";
            if (node.kind !== "salesAngles" || activeId) await billingStore().update(`workflow:${run.id}:${nodeId}${suffix}`, "UNCONFIRMED", error instanceof UsageReportedError ? error.usage : undefined).catch(() => undefined);
        }
        await mutate((current, state) => {
            const safe = error instanceof WorkflowError ? error.message : publicErrorMessage(error);
            if (previous.status === "polling" && !(error instanceof WorkflowError) && (state.pollErrors ?? 0) < 4) {
                state.pollErrors = (state.pollErrors ?? 0) + 1;
                state.nextPollAt = Date.now() + 15_000 * state.pollErrors;
                state.error = `Reintentando consulta: ${safe}`;
            } else {
                state.status = submitted ? "review" : "failed";
                state.error = submitted ? `${safe}. No se reenviará la generación. Revisa el proveedor antes de volver a generar.` : safe;
                if (node.kind === "salesAngles" && selectedAngleId && state.angles?.[selectedAngleId]) {
                    const angleState = state.angles[selectedAngleId];
                    const formatState = selectedFormatKey ? angleState.formats?.[selectedFormatKey] ?? angleState : angleState;
                    angleState.status = state.status; angleState.error = state.error;
                    formatState.status = state.status; formatState.error = state.error;
                    state.activeAngleId = selectedAngleId;
                    state.activeFormatKey = angleState.formats ? selectedFormatKey : undefined;
                }
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
