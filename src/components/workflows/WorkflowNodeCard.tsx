"use client";
/* eslint-disable @next/next/no-img-element -- Private authenticated media must bypass the shared image optimizer. */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Upload, LoaderCircle } from "lucide-react";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { outputKind, statusLabels, type WorkflowNode, type NodeRun } from "@/workflows/types";
import { kindLabels } from "@/workflows/templates";
import { nodeIcons } from "./node-icons";
import { angleFormats } from "@/workflows/sales-angles";

export type CanvasNode = Node<{ node: WorkflowNode; capability?: ModelCapabilities; state?: NodeRun; now: number }, "workflow">;
export function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
    const { node, capability, state, now } = data;
    const Icon = nodeIcons[node.kind];
    const busy = state && ["preparing", "submitting", "polling"].includes(state.status);
    const slots = capability?.media_slots.filter(s => s.kind === "image") ?? [];
    const preview = state?.value?.assetIds?.[0] ?? node.config.assetId;
    return <div className={`wf-node ${selected ? "wf-node-selected" : ""} wf-node-${node.kind}`}>
        <div className="wf-node-heading"><span className="wf-node-icon"><Icon size={16} /></span><span>{kindLabels[node.kind]}</span><span className="wf-node-type">{node.kind === "manualTrigger" ? "DISPARADOR" : "NODO"}</span></div>
        <strong>{node.label}</strong>
        {["image", "video"].includes(node.kind) && <p className="wf-node-model">{capability?.label ?? (node.config.modelId ? "Modelo guardado" : "Selecciona un modelo →")}</p>}
        {(node.kind === "prompt" || node.kind === "audio" || state?.value?.kind === "text") && <p className="wf-node-text">{state?.value?.text ?? node.config.text ?? "Escribe tu idea…"}</p>}
        {node.kind === "salesAngles" && <div className="wf-angles-node-list">{node.config.angles?.map((angle, index) => <div className="wf-angles-node-row" key={angle.id}>
            <span>{index + 1}. {angle.text || "Nuevo ángulo"}</span><small>{angleFormats(angle).filter(format => !!format.format).length} {angleFormats(angle).filter(format => !!format.format).length === 1 ? "formato" : "formatos"} · {state?.angles?.[angle.id] ? statusLabels[state.angles[angle.id].status] : "pendiente"}</small>
            <Handle type="source" position={Position.Right} id={`angle:${angle.id}`} style={{ top: 113 + index * 32, background: "#ff4d4d" }} />
        </div>)}</div>}
        {preview && (outputKind(node) === "audio" ? <audio className="nodrag wf-preview" src={`/api/workflows/assets/${preview}`} controls preload="none" /> : outputKind(node) === "video" ? <video className="nodrag wf-preview" src={`/api/workflows/assets/${preview}`} controls preload="metadata" /> : <img className="wf-preview" src={`/api/workflows/assets/${preview}`} alt="Resultado del bloque" />)}
        {node.kind === "asset" && !preview && <div className="wf-placeholder"><Upload size={22} /><span>Elige una imagen de la galería o súbela</span></div>}
        {node.kind === "approval" && !state && <p className="wf-node-text">El flujo esperará tu aprobación.</p>}
        {node.kind === "manualTrigger" && !state && <p className="wf-node-text">Se activa al pulsar Ejecutar. No inicia automáticamente.</p>}
        {state && <div className={`wf-status wf-status-${state.status}`} role="status">{busy && <LoaderCircle size={13} className="animate-spin" />}{statusLabels[state.status]}{busy && state.startedAt && <span>{Math.max(0, Math.floor((now - state.startedAt) / 1000))} s</span>}</div>}
        {state?.error && <p className="wf-node-error">{state.error}</p>}
        {node.kind !== "manualTrigger" && <><Handle type="target" position={Position.Left} id="start" style={{ top: 16, background: "#ff4d4d" }} /><span className="wf-port-label" style={{ top: 5 }}>inicio</span></>}
        {["image", "video", "audio"].includes(node.kind) && <>
            <Handle type="target" position={Position.Left} id="prompt" style={{ top: 47, background: "#bdbdbd" }} /><span className="wf-port-label" style={{ top: 37 }}>texto</span>
            {slots.map((slot, index) => <div key={slot.id}><Handle type="target" position={Position.Left} id={`slot:${slot.id}`} style={{ top: 90 + index * 26, background: "#ff4d4d" }} /><span className="wf-port-label" style={{ top: 80 + index * 26 }}>{slot.label}</span></div>)}
            {slots.length > 1 && <div style={{ height: slots.length * 22 }} />}
        </>}
        {node.kind === "salesAngles" && <><Handle type="target" position={Position.Left} id="prompt" style={{ top: 47, background: "#bdbdbd" }} /><span className="wf-port-label" style={{ top: 37 }}>contexto</span></>}
        {["approval", "output"].includes(node.kind) && <Handle type="target" position={Position.Left} id="input" />}
        {node.kind !== "output" && <Handle type="source" position={Position.Right} id="output" style={{ background: node.kind === "manualTrigger" ? "#ff4d4d" : outputKind(node) === "text" ? "#bdbdbd" : "#ff4d4d" }} />}
    </div>;
}
