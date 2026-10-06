"use client";
/* eslint-disable @next/next/no-img-element -- Private authenticated media must bypass the shared image optimizer. */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ImageIcon, Film, Type, CircleCheck, Download, Upload, LoaderCircle } from "lucide-react";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { outputKind, statusLabels, type WorkflowNode, type NodeRun } from "@/workflows/types";
import { kindLabels } from "@/workflows/templates";

export type CanvasNode = Node<{ node: WorkflowNode; capability?: ModelCapabilities; state?: NodeRun; now: number }, "workflow">;
const icons = { prompt: Type, asset: Upload, image: ImageIcon, video: Film, approval: CircleCheck, output: Download };
export function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
    const { node, capability, state, now } = data;
    const Icon = icons[node.kind];
    const busy = state && ["preparing", "submitting", "polling"].includes(state.status);
    const slots = capability?.media_slots.filter(s => s.kind === "image") ?? [];
    const preview = state?.value?.assetIds?.[0] ?? node.config.assetId;
    return <div className={`wf-node ${selected ? "wf-node-selected" : ""} wf-node-${node.kind}`}>
        <div className="wf-node-heading"><span className="wf-node-icon"><Icon size={16} /></span><span>{kindLabels[node.kind]}</span><span className="wf-node-type">{outputKind(node)}</span></div>
        <strong>{node.label}</strong>
        {["image", "video"].includes(node.kind) && <p className="wf-node-model">{capability?.label ?? (node.config.modelId ? "Modelo guardado" : "Selecciona un modelo →")}</p>}
        {(node.kind === "prompt" || state?.value?.kind === "text") && <p className="wf-node-text">{state?.value?.text ?? node.config.text ?? "Escribe tu idea…"}</p>}
        {preview && (outputKind(node) === "video" ? <video className="nodrag wf-preview" src={`/api/workflows/assets/${preview}`} controls preload="metadata" /> : <img className="wf-preview" src={`/api/workflows/assets/${preview}`} alt="Resultado del bloque" />)}
        {node.kind === "asset" && !preview && <div className="wf-placeholder"><Upload size={22} /><span>Selecciona y sube una imagen</span></div>}
        {node.kind === "approval" && !state && <p className="wf-node-text">El flujo esperará tu aprobación.</p>}
        {state && <div className={`wf-status wf-status-${state.status}`} role="status">{busy && <LoaderCircle size={13} className="animate-spin" />}{statusLabels[state.status]}{busy && state.startedAt && <span>{Math.max(0, Math.floor((now - state.startedAt) / 1000))} s</span>}</div>}
        {state?.error && <p className="wf-node-error">{state.error}</p>}
        {["image", "video"].includes(node.kind) && <>
            <Handle type="target" position={Position.Left} id="prompt" style={{ top: 47, background: "#a5b4fc" }} /><span className="wf-port-label" style={{ top: 37 }}>texto</span>
            {slots.map((slot, index) => <div key={slot.id}><Handle type="target" position={Position.Left} id={`slot:${slot.id}`} style={{ top: 90 + index * 26, background: "#d5ff47" }} /><span className="wf-port-label" style={{ top: 80 + index * 26 }}>{slot.label}</span></div>)}
            {slots.length > 1 && <div style={{ height: slots.length * 22 }} />}
        </>}
        {["approval", "output"].includes(node.kind) && <Handle type="target" position={Position.Left} id="input" />}
        {node.kind !== "output" && <Handle type="source" position={Position.Right} id="output" style={{ background: outputKind(node) === "text" ? "#a5b4fc" : "#d5ff47" }} />}
    </div>;
}
