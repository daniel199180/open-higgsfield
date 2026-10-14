import { z } from "zod";
import type { ModelCapabilities } from "@/models/capabilities/types";

export const nodeKinds = ["manualTrigger", "prompt", "asset", "image", "video", "audio", "salesAngles", "approval", "output"] as const;
export type NodeKind = typeof nodeKinds[number];
export type ValueKind = "text" | "image" | "video" | "audio";
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const valueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
export const MAX_GENERATIONS = 30;
export const angleFormatSchema = z.object({ formatField: z.enum(["aspect_ratio", "size"]), format: z.string().min(1).max(100) }).strict();
export type AngleFormat = z.infer<typeof angleFormatSchema>;
export const angleSchema = z.object({
    id: idSchema,
    text: z.string().trim().max(2000),
    modelId: z.string().max(500),
    formatField: z.enum(["aspect_ratio", "size"]),
    format: z.string().max(100),
    additionalFormats: z.array(angleFormatSchema).max(MAX_GENERATIONS - 1).optional(),
    resolution: z.string().max(100).optional(),
    brandId: z.uuid().optional(),
}).strict();
export type SalesAngle = z.infer<typeof angleSchema>;
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
            valueKind: z.enum(["text", "image", "video", "audio"]).optional(),
            voiceId: z.uuid().optional(),
            angles: z.array(angleSchema).min(1).max(MAX_GENERATIONS).optional(),
            params: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/), valueSchema).refine(v => Object.keys(v).length <= 30).optional(),
        }).strict(),
    }).strict()).min(1).max(30),
    edges: z.array(z.object({ id: idSchema, source: idSchema, sourceHandle: z.string().max(100).optional(), target: idSchema, targetHandle: z.string().max(100) }).strict()).max(60),
}).strict();
export type WorkflowGraph = z.infer<typeof graphSchema>;
export type WorkflowNode = WorkflowGraph["nodes"][number];
export interface Workflow { id: string; name: string; revision: number; graph: WorkflowGraph; createdAt: number; updatedAt: number; deletedAt?: number }
export interface Asset { id: string; kind: "image" | "video" | "vector" | "audio"; mime: string; bytes: number; createdAt: number }
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
    activeAngleId?: string;
    activeFormatKey?: string;
    angles?: Record<string, NodeRun>;
    formats?: Record<string, NodeRun>;
    canResume?: boolean;
    canRetry?: boolean;
}
export type RunStatus = "queued" | "running" | "approval" | "completed" | "failed" | "review" | "cancelled";
export interface WorkflowRun {
    id: string; workflowId: string; revision: number; name: string; graph: WorkflowGraph;
    companyId?: string;
    status: RunStatus; nodes: Record<string, NodeRun>;
    capabilities: Record<string, ModelCapabilities>;
    angleContexts?: Record<string, { prompt: string; logoAssetId?: string; logoAssetIds?: string[] }>;
    createdAt: number; updatedAt: number; leaseOwner?: string; leaseUntil?: number;
    requestKey: string; fingerprint: string; cancelRequested?: boolean;
    events: Array<{ at: number; nodeId?: string; message: string }>;
}
export type PublicRun = Omit<WorkflowRun, "capabilities" | "angleContexts" | "leaseOwner" | "leaseUntil" | "requestKey" | "fingerprint">;
export const statusLabels: Record<NodeStatus | RunStatus, string> = {
    queued: "En cola", running: "Ejecutando", pending: "Pendiente", preparing: "Preparando",
    submitting: "Generando", polling: "Generando", approval: "Esperando aprobación",
    completed: "Completado", failed: "Error", review: "Revisar solicitud", cancelled: "Detenido",
};
export class WorkflowError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
export function outputKind(node: WorkflowNode): ValueKind {
    if (node.kind === "manualTrigger" || node.kind === "prompt") return "text";
    if (node.kind === "asset" || node.kind === "image" || node.kind === "salesAngles") return "image";
    if (node.kind === "video") return "video";
    if (node.kind === "audio") return "audio";
    return node.config.valueKind ?? "image";
}
export function publicRun(run: WorkflowRun): PublicRun {
    const safeNode = (node: NodeRun) => ({
        status: node.status, value: node.value, startedAt: node.startedAt, finishedAt: node.finishedAt,
        error: node.error, providerTaskId: node.providerTaskId,
    });
    return {
        id: run.id, workflowId: run.workflowId, revision: run.revision, name: run.name, graph: run.graph,
        status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, cancelRequested: run.cancelRequested, events: run.events,
        nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [id, {
            ...safeNode(node), activeAngleId: node.activeAngleId, activeFormatKey: node.activeFormatKey,
            canResume: node.status === "review" && !!(node.activeAngleId ? (node.activeFormatKey ? node.angles?.[node.activeAngleId]?.formats?.[node.activeFormatKey]?.operation : node.angles?.[node.activeAngleId]?.operation) : node.operation),
            canRetry: node.status === "failed" && !!node.activeAngleId && !!(node.activeFormatKey ? node.angles?.[node.activeAngleId]?.formats?.[node.activeFormatKey] : node.angles?.[node.activeAngleId]) && !((node.activeFormatKey ? node.angles?.[node.activeAngleId]?.formats?.[node.activeFormatKey] : node.angles?.[node.activeAngleId])?.operation) && !((node.activeFormatKey ? node.angles?.[node.activeAngleId]?.formats?.[node.activeFormatKey] : node.angles?.[node.activeAngleId])?.providerTaskId),
            ...(node.angles ? { angles: Object.fromEntries(Object.entries(node.angles).map(([angleId, angle]) => [angleId, {
                ...safeNode(angle),
                ...(angle.formats ? { formats: Object.fromEntries(Object.entries(angle.formats).map(([key, format]) => [key, safeNode(format)])) } : {}),
            }])) } : {}),
        }])),
    };
}
