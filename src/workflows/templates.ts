import type { WorkflowGraph, NodeKind } from "./types";

export const kindLabels: Record<NodeKind, string> = { prompt: "Prompt", asset: "Imagen de entrada", image: "Generar imagen", video: "Generar video", approval: "Aprobación", output: "Resultado" };

/** A new editable draft, not a navigation back to the template gallery. */
export function blankWorkflowGraph(): WorkflowGraph {
    return {
        version: 1,
        nodes: [{ id: "prompt", kind: "prompt", label: "Mi idea", position: { x: 80, y: 120 }, config: { text: "" } }],
        edges: [],
    };
}
export const templates = [
    { id: "image", name: "De una idea a una imagen", description: "Prompt → imagen → resultado. El punto de partida más sencillo.", badge: "IMAGEN" },
    { id: "video", name: "De imagen a video", description: "Genera una imagen, apruébala y dale movimiento con otro modelo.", badge: "IMAGEN + VIDEO" },
    { id: "reference", name: "Transformar una referencia", description: "Sube una foto y conéctala a un modelo que admita imágenes.", badge: "REFERENCIA" },
    { id: "demo", name: "Prueba sin créditos", description: "Texto → aprobación → resultado. Conoce el editor sin usar APIs.", badge: "SIN COSTE" },
] as const;

export function templateGraph(id: string): WorkflowGraph {
    const prompt = { id: "prompt", kind: "prompt" as const, label: "Describe tu idea", position: { x: 0, y: 120 }, config: { text: id === "demo" ? "Mi primer workflow: revisa este texto y aprueba para continuar." : "Fotografía editorial de un producto sobre una superficie de piedra clara, iluminación suave de estudio, composición minimalista." } };
    if (id === "demo") return { version: 1, nodes: [prompt,
        { id: "approve", kind: "approval", label: "Revisar texto", position: { x: 340, y: 120 }, config: { valueKind: "text" } },
        { id: "output", kind: "output", label: "Resultado", position: { x: 680, y: 120 }, config: { valueKind: "text" } },
    ], edges: [{ id: "e1", source: "prompt", target: "approve", targetHandle: "input" }, { id: "e2", source: "approve", target: "output", targetHandle: "input" }] };
    const graph: WorkflowGraph = { version: 1, nodes: [prompt,
        { id: "image", kind: "image", label: "Crear imagen", position: { x: 340, y: 120 }, config: {} },
    ], edges: [{ id: "e1", source: "prompt", target: "image", targetHandle: "prompt" }] };
    if (id === "reference") graph.nodes.push({ id: "asset", kind: "asset", label: "Tu referencia", position: { x: 0, y: 380 }, config: {} });
    if (id === "video") {
        graph.nodes.push(
            { id: "approve", kind: "approval", label: "Aprobar imagen", position: { x: 680, y: 120 }, config: { valueKind: "image" } },
            { id: "video", kind: "video", label: "Dar movimiento", position: { x: 1020, y: 120 }, config: { text: "Movimiento de cámara lento y cinematográfico, conservar la apariencia del producto." } },
            { id: "output", kind: "output", label: "Video final", position: { x: 1360, y: 120 }, config: { valueKind: "video" } },
        );
        graph.edges.push({ id: "e2", source: "image", target: "approve", targetHandle: "input" }, { id: "e3", source: "approve", target: "video", targetHandle: "slot:start_image" }, { id: "e4", source: "video", target: "output", targetHandle: "input" });
    } else {
        graph.nodes.push({ id: "output", kind: "output", label: "Imagen final", position: { x: 680, y: 120 }, config: { valueKind: "image" } });
        graph.edges.push({ id: "e2", source: "image", target: "output", targetHandle: "input" });
    }
    return graph;
}
