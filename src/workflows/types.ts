import { z } from "zod";
import type { ModelCapabilities } from "@/models/capabilities/types";

export const nodeKinds = ["prompt", "asset", "image", "video", "approval", "output"] as const;
export type NodeKind = typeof nodeKinds[number];
export type ValueKind = "text" | "image" | "video";
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const valueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
export const graphSchema = z.object({
    version: z.literal(1),
    nodes: z.array(z.object({
        id: idSchema,
        kind: z.enum(nodeKinds),
        label: z.string().trim().min(1).max(80),
        position: z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict(),
        config: z.object({
            text: z.string().max(10000).optional(),
            modelId: z.string().max(500).optional(),
            assetId: z.uuid().optional(),
            valueKind: z.enum(["text", "image", "video"]).optional(),
            params: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/), valueSchema).refine(v => Object.keys(v).length <= 30).optional(),
        }).strict(),
    }).strict()).min(1).max(30),
    edges: z.array(z.object({ id: idSchema, source: idSchema, target: idSchema, targetHandle: z.string().max(100) }).strict()).max(60),
}).strict();
export type WorkflowGraph = z.infer<typeof graphSchema>;
export type WorkflowNode = WorkflowGraph["nodes"][number];
export interface Workflow { id: string; name: string; revision: number; graph: WorkflowGraph; createdAt: number; updatedAt: number }
export interface Asset { id: string; kind: "image" | "video"; mime: string; bytes: number; createdAt: number }
export interface NodeValue { kind: ValueKind; text?: string; assetIds?: string[] }
export type NodeStatus = "pending" | "preparing" | "submitting" | "polling" | "approval" | "completed" | "failed" | "review" | "cancelled";
export interface NodeRun {
    status: NodeStatus;
    value?: NodeValue;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    operation?: unknown;
    providerTaskId?: string;
    nextPollAt?: number;
    pollErrors?: number;
}
export type RunStatus = "queued" | "running" | "approval" | "completed" | "failed" | "review" | "cancelled";
export interface WorkflowRun {
    id: string; workflowId: string; revision: number; name: string; graph: WorkflowGraph;
    status: RunStatus; nodes: Record<string, NodeRun>;
    capabilities: Record<string, ModelCapabilities>;
    createdAt: number; updatedAt: number; leaseOwner?: string; leaseUntil?: number;
    requestKey: string; fingerprint: string; cancelRequested?: boolean;
    events: Array<{ at: number; nodeId?: string; message: string }>;
}
export type PublicRun = Omit<WorkflowRun, "capabilities" | "leaseOwner" | "leaseUntil" | "requestKey" | "fingerprint">;
export const statusLabels: Record<NodeStatus | RunStatus, string> = {
    queued: "En cola", running: "Ejecutando", pending: "Pendiente", preparing: "Preparando",
    submitting: "Generando", polling: "Generando", approval: "Esperando aprobación",
    completed: "Completado", failed: "Error", review: "Revisar solicitud", cancelled: "Detenido",
};
export class WorkflowError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
export function outputKind(node: WorkflowNode): ValueKind {
    if (node.kind === "prompt") return "text";
    if (node.kind === "asset" || node.kind === "image") return "image";
    if (node.kind === "video") return "video";
    return node.config.valueKind ?? "image";
}
export function publicRun(run: WorkflowRun): PublicRun {
    return {
        id: run.id, workflowId: run.workflowId, revision: run.revision, name: run.name, graph: run.graph,
        status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, cancelRequested: run.cancelRequested, events: run.events,
        nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [id, {
            status: node.status, value: node.value, startedAt: node.startedAt, finishedAt: node.finishedAt,
            error: node.error, providerTaskId: node.providerTaskId,
        }])),
    };
}
