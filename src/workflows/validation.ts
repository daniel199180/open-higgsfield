import type { ModelCapabilities } from "@/models/capabilities/types";
import type { CanonicalParams } from "@/models/canonical";
import { graphSchema, outputKind, WorkflowError, type WorkflowGraph, type WorkflowNode } from "./types";

export function validateGraph(input: unknown): WorkflowGraph {
    const parsed = graphSchema.safeParse(input);
    if (!parsed.success) throw new WorkflowError("El workflow contiene campos inválidos o supera los límites (30 bloques / 60 conexiones).");
    const graph = parsed.data;
    const ids = new Set(graph.nodes.map(n => n.id));
    if (ids.size !== graph.nodes.length || new Set(graph.edges.map(e => e.id)).size !== graph.edges.length) throw new WorkflowError("Hay identificadores duplicados.");
    const handles = new Set<string>();
    for (const edge of graph.edges) {
        const from = graph.nodes.find(n => n.id === edge.source), to = graph.nodes.find(n => n.id === edge.target);
        if (!from || !to || from.id === to.id) throw new WorkflowError("Conexión inválida.");
        const key = `${to.id}:${edge.targetHandle}`;
        if (handles.has(key)) throw new WorkflowError("Cada entrada admite una conexión. Usa un bloque separado para otra variante.");
        handles.add(key);
        const kind = outputKind(from);
        const valid = ["image", "video"].includes(to.kind)
            ? (edge.targetHandle === "prompt" && kind === "text") || (edge.targetHandle.startsWith("slot:") && kind === "image")
            : ["approval", "output"].includes(to.kind) && edge.targetHandle === "input" && kind === outputKind(to);
        if (!valid) throw new WorkflowError("Los tipos de entrada y salida no son compatibles.");
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new WorkflowError("No se permiten ciclos en un workflow.");
        if (visited.has(id)) return;
        visiting.add(id);
        graph.edges.filter(e => e.source === id).forEach(e => visit(e.target));
        visiting.delete(id); visited.add(id);
    };
    graph.nodes.forEach(n => visit(n.id));
    if (graph.nodes.filter(n => ["image", "video"].includes(n.kind)).length > 6) throw new WorkflowError("Máximo 6 generaciones por ejecución.");
    return graph;
}

export function executionGraph(graph: WorkflowGraph, targetId?: string): WorkflowGraph {
    if (!targetId) return graph;
    if (!graph.nodes.some(n => n.id === targetId)) throw new WorkflowError("El bloque ya no existe.");
    const ids = new Set([targetId]);
    for (let i = 0; i < graph.nodes.length; i++) for (const edge of graph.edges) if (ids.has(edge.target)) ids.add(edge.source);
    return { ...graph, nodes: graph.nodes.filter(n => ids.has(n.id)), edges: graph.edges.filter(e => ids.has(e.target) && ids.has(e.source)) };
}

export function parameterOptions(caps: ModelCapabilities): Array<{ id: string; label: string; type: "select" | "number" | "checkbox" | "text"; options?: string[]; minimum?: number; maximum?: number }> {
    return [
        ...(caps.duration && caps.duration.options?.length ? [{ id: "duration", label: "Duración", type: "select" as const, options: caps.duration.options }] : []),
        ...(caps.aspect_ratio && caps.aspect_ratio.options?.length ? [{ id: "aspect_ratio", label: "Proporción", type: "select" as const, options: caps.aspect_ratio.options.map(o => o[1]) }] : []),
        ...(caps.resolution_variant && caps.resolution_variant.options?.length ? [{ id: "resolution", label: "Resolución", type: "select" as const, options: caps.resolution_variant.options }] : []),
        ...(caps.size && caps.size.options?.length ? [{ id: "size", label: "Tamaño", type: "select" as const, options: caps.size.options.map(o => o[1]) }] : []),
        ...caps.custom_fields.filter(f => !/safety|^n$|num_images|batch|webhook|url|callback/i.test(f.id)),
    ].filter((f, i, all) => all.findIndex(other => other.id === f.id) === i);
}

export function canonicalParams(node: WorkflowNode, caps: ModelCapabilities, prompt: string): CanonicalParams {
    if (prompt.length > (caps.prompt_max ?? 10000) || (caps.prompt_required && !prompt.trim())) throw new WorkflowError(`Revisa el prompt de «${node.label}».`);
    const fields = parameterOptions(caps);
    const values = node.config.params ?? {};
    for (const [id, value] of Object.entries(values)) {
        const field = fields.find(f => f.id === id);
        if (!field) throw new WorkflowError(`«${node.label}»: parámetro no compatible: ${id}.`);
        if (field.type === "select" && (!field.options?.length || !field.options.includes(String(value)))) throw new WorkflowError(`«${node.label}»: valor no admitido para ${field.label}.`);
        if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < (field.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER))) throw new WorkflowError(`«${node.label}»: número fuera de rango.`);
        if (field.type === "checkbox" && typeof value !== "boolean") throw new WorkflowError("Opción booleana inválida.");
        if (field.type === "text" && typeof value !== "string") throw new WorkflowError("Opción de texto inválida.");
    }
    // Do not invent defaults: omit optional values so each provider uses its own defaults.
    return {
        model_id: caps.id, prompt,
        ...(values.duration ? { duration: String(values.duration) } : {}),
        ...(values.aspect_ratio ? { aspect_ratio: String(values.aspect_ratio) } : {}),
        ...(values.resolution ? { resolution: String(values.resolution) } : {}),
        ...(values.size ? { size: String(values.size) } : {}),
        ...(typeof values.seed === "number" ? { seed: values.seed } : {}),
        field_values: values,
    };
}

export function validateRunnable(graph: WorkflowGraph, caps: Record<string, ModelCapabilities>) {
    for (const node of graph.nodes) {
        const incoming = graph.edges.filter(e => e.target === node.id);
        if (node.kind === "prompt" && !node.config.text?.trim()) throw new WorkflowError(`Escribe el texto de «${node.label}».`);
        if (node.kind === "asset" && !node.config.assetId) throw new WorkflowError(`Sube una imagen en «${node.label}».`);
        if (["approval", "output"].includes(node.kind) && incoming.length !== 1) throw new WorkflowError(`Conecta la entrada de «${node.label}».`);
        if (!["image", "video"].includes(node.kind)) continue;
        const cap = caps[node.id];
        if (!cap) throw new WorkflowError(`Elige un modelo disponible en «${node.label}».`);
        if (cap.provider === "api-market") throw new WorkflowError("API.market necesita un contrato específico de entradas y salidas antes de habilitarse en workflows. La generación individual sigue disponible.");
        if (cap.provider !== "openrouter" && cap.provider !== "higgsfield") throw new WorkflowError("La primera versión de workflows admite OpenRouter y Higgsfield. Los demás proveedores siguen disponibles en Studio.");
        for (const edge of incoming.filter(e => e.targetHandle !== "prompt")) {
            const slot = cap.media_slots.find(s => `slot:${s.id}` === edge.targetHandle && s.kind === "image");
            if (!slot) throw new WorkflowError(`«${node.label}»: el modelo no admite esa entrada de imagen.`);
            if (cap.provider === "higgsfield" && cap.provider_model_id?.includes("text-to-video")) throw new WorkflowError("Ese endpoint de Higgsfield es de texto a video. Elige un modelo con imagen de entrada verificada.");
        }
        for (const slot of cap.media_slots.filter(s => s.required)) if (!incoming.some(e => e.targetHandle === `slot:${slot.id}`)) throw new WorkflowError(`«${node.label}»: falta ${slot.label}.`);
        canonicalParams(node, cap, incoming.some(e => e.targetHandle === "prompt") ? "Prompt conectado" : node.config.text ?? "");
    }
}
