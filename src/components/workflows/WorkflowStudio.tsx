"use client";
/* eslint-disable @next/next/no-img-element -- Private authenticated media must bypass the shared image optimizer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, applyNodeChanges, applyEdgeChanges, type Edge, type Connection, type ReactFlowInstance } from "@xyflow/react";
import { ArrowLeft, Workflow as WorkflowIcon, Plus, Play, Save, Copy, X, Upload, Download, LoaderCircle, CircleCheck, Square } from "lucide-react";
import type { ModelCapabilities } from "@/models/capabilities/types";
import { statusLabels, type Workflow, type WorkflowGraph, type PublicRun, type Asset, type NodeKind } from "@/workflows/types";
import { validateGraph, parameterOptions, executionGraph } from "@/workflows/validation";
import { templates, templateGraph, blankWorkflowGraph, kindLabels } from "@/workflows/templates";
import { WorkflowNodeCard, type CanvasNode } from "./WorkflowNodeCard";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { GenerationPrice } from "@/components/studio/GenerationPrice";
import { UsagePanel } from "@/components/studio/UsagePanel";
import "@xyflow/react/dist/style.css";
import "./workflows.css";

const nodeTypes = { workflow: WorkflowNodeCard };
type RunSummary = Pick<PublicRun, "id" | "workflowId" | "revision" | "name" | "status" | "createdAt">;
async function api<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "No se pudo completar la operación.");
    return value;
}
export function WorkflowStudio({ onBack }: { onBack: () => void }) {
    const [usageOpen, setUsageOpen] = useState(false);
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [models, setModels] = useState<Array<ModelCapabilities & { mediaType: "image" | "video" }>>([]);
    const [workflow, setWorkflow] = useState<Workflow | null>(null);
    const [graph, setGraph] = useState<WorkflowGraph | null>(null);
    const [name, setName] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [run, setRun] = useState<PublicRun | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [now, setNow] = useState(0);
    const [storage, setStorage] = useState("");
    const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({});
    const [draftVersion, setDraftVersion] = useState(0);
    const [discardRequest, setDiscardRequest] = useState<{ resolve: (discard: boolean) => void } | null>(null);
    const [confirm, setConfirm] = useState<{ targetId?: string; key: string } | null>(null);
    const flow = useRef<ReactFlowInstance<CanvasNode, Edge>>(null);
    const busyRef = useRef(false);
    const dirty = !!graph && !run && (!workflow || name !== workflow.name || JSON.stringify(graph) !== JSON.stringify(workflow.graph));
    const activeNode = graph?.nodes.find(n => n.id === selected);
    const activeCap = models.find(m => m.id === activeNode?.config.modelId);
    const activeState = selected ? run?.nodes[selected] : undefined;

    useEffect(() => {
        let frame = 0;
        const resize = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.25, maxZoom: 0.85 }); });
        };
        window.addEventListener("resize", resize);
        return () => { window.removeEventListener("resize", resize); cancelAnimationFrame(frame); };
    }, []);

    const refresh = useCallback(async () => {
        const result = await api<{ workflows: Workflow[]; runs: RunSummary[]; assets: Asset[]; storage: string }>("/api/workflows");
        setWorkflows(result.workflows); setRuns(result.runs); setAssets(result.assets); setStorage(result.storage);
        return result;
    }, []);
    const updateUrl = (workflowId?: string, runId?: string) => {
        const url = new URL(window.location.href);
        url.searchParams.set("workspace", "workflows");
        if (workflowId) url.searchParams.set("workflow", workflowId); else url.searchParams.delete("workflow");
        if (runId) url.searchParams.set("run", runId); else url.searchParams.delete("run");
        window.history.replaceState(null, "", url);
    };
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const result = await refresh();
                if (cancelled) return;
                const params = new URLSearchParams(window.location.search);
                const saved = result.workflows.find(w => w.id === params.get("workflow"));
                if (saved) { setWorkflow(saved); setGraph(saved.graph); setName(saved.name); }
                if (params.get("run")) {
                    const response = await api<{ run: PublicRun }>(`/api/workflows/runs/${encodeURIComponent(params.get("run")!)}`);
                    if (!cancelled) { setRun(response.run); setGraph(response.run.graph); setName(response.run.name); }
                }
                const catalogs = await Promise.all(["image", "video"].map(async mediaType => {
                    const data = await api<{ models: ModelCapabilities[] }>(`/api/catalog?mediaType=${mediaType}`);
                    return data.models.filter(m => m.provider === "openrouter" || m.provider === "higgsfield").map(m => ({ ...m, mediaType: mediaType as "image" | "video" }));
                }));
                if (!cancelled) setModels(catalogs.flat());
            } catch (err) { if (!cancelled) setError((err as Error).message); }
            finally { if (!cancelled) setLoading(false); }
        })();
        return () => { cancelled = true; };
    }, [refresh]);
    useEffect(() => {
        if (!run) return;
        let cancelled = false;
        const timer = window.setInterval(() => {
            setNow(Date.now());
            void api<{ run: PublicRun }>(`/api/workflows/runs/${run.id}`).then(value => {
                if (!cancelled) setRun(value.run);
            }).catch(err => { if (!cancelled) setError(`No se pudo actualizar el estado: ${err.message}. No vuelvas a generar; reintenta consultar.`); });
        }, 2000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!dirty) return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const leaveDraft = async () => !dirty || await new Promise<boolean>(resolve => setDiscardRequest({ resolve }));
    const resolveDiscard = (discard: boolean) => {
        discardRequest?.resolve(discard);
        setDiscardRequest(null);
    };
    const perform = async (fn: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setError(""); setNotice("");
        try { await fn(); } catch (err) { setError((err as Error).message); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const open = async (w: Workflow) => {
        if (!await leaveDraft()) return;
        setWorkflow(w); setGraph(w.graph); setName(w.name); setRun(null); setSelected(null); setError(""); setNotice(""); updateUrl(w.id);
    };
    const createWorkflow = async () => {
        if (!await leaveDraft()) return;
        const next = blankWorkflowGraph();
        setWorkflow(null); setRun(null); setGraph(next); setName("Workflow sin título");
        setSelected(next.nodes[0].id); setDimensions({}); setDraftVersion(v => v + 1);
        setConfirm(null); setError("");
        setNotice("Nuevo borrador creado. Escribe tu idea, añade bloques y pulsa Guardar.");
        updateUrl();
    };
    const newTemplate = async (id: string) => {
        if (!await leaveDraft()) return;
        const next = templateGraph(id);
        const imageModel = models.find(m => m.mediaType === "image" && /banana|gemini.*image/i.test(m.label + m.provider_model_id));
        const videoModel = models.find(m => m.mediaType === "video" && m.provider === "openrouter" && m.media_slots.some(s => s.id === "start_image"));
        next.nodes.forEach(n => { if (n.kind === "image" && imageModel) n.config.modelId = imageModel.id; if (n.kind === "video" && videoModel) n.config.modelId = videoModel.id; });
        setWorkflow(null); setRun(null); setGraph(next); setSelected(next.nodes[0].id); setName(templates.find(t => t.id === id)?.name ?? "Mi workflow"); setNotice(""); setError(""); updateUrl();
    };
    const save = async () => {
        if (!graph) throw new Error("Crea un workflow primero.");
        validateGraph(graph);
        const result = await api<{ workflow: Workflow }>("/api/workflows", { action: "save", id: workflow?.id, revision: workflow?.revision, name, graph });
        setWorkflow(result.workflow); setGraph(result.workflow.graph); updateUrl(result.workflow.id); await refresh();
        setNotice("Workflow guardado en el servidor.");
        return result.workflow;
    };
    const launch = () => perform(async () => {
        if (!confirm) return;
        const saved = dirty ? await save() : workflow;
        if (!saved) return;
        const result = await api<{ run: PublicRun }>("/api/workflows", { action: "run", workflowId: saved.id, revision: saved.revision, key: confirm.key, targetId: confirm.targetId, acknowledgeCost: true });
        setRun(result.run); setGraph(result.run.graph); setConfirm(null); setNow(Date.now()); updateUrl(saved.id, result.run.id); await refresh();
    });
    const action = (kind: "approve" | "cancel" | "resume", nodeId?: string) => perform(async () => {
        if (!run) return;
        const result = await api<{ run: PublicRun }>("/api/workflows", { action: kind, runId: run.id, nodeId });
        setRun(result.run); await refresh();
    });
    const patchNode = (patch: Partial<NonNullable<typeof activeNode>>) => {
        if (!activeNode || !graph || run) return;
        setGraph({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...patch } : n) });
    };
    const connect = (connection: Connection) => {
        if (!graph || run) return;
        const edge = { id: crypto.randomUUID(), source: connection.source, target: connection.target, targetHandle: connection.targetHandle ?? "input" };
        try { setGraph(validateGraph({ ...graph, edges: [...graph.edges, edge] })); setError(""); }
        catch (err) { setError((err as Error).message); }
    };
    const addNode = (kind: NodeKind) => {
        if (!graph || run) return;
        if (graph.nodes.length >= 30) { setError("Máximo 30 bloques."); return; }
        const id = crypto.randomUUID();
        const position = flow.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 300, y: 300 };
        setGraph({ ...graph, nodes: [...graph.nodes, { id, kind, label: kindLabels[kind], position, config: kind === "approval" || kind === "output" ? { valueKind: "image" } : {} }] }); setSelected(id);
    };
    const canvasNodes: CanvasNode[] = graph?.nodes.map(node => ({ id: node.id, type: "workflow", position: node.position, measured: dimensions[node.id], selected: node.id === selected, data: { node, capability: models.find(m => m.id === node.config.modelId), state: run?.nodes[node.id], now } })) ?? [];
    const edges: Edge[] = graph?.edges.map(edge => ({ ...edge, sourceHandle: "output", animated: !!run && ["preparing", "submitting", "polling"].includes(run.nodes[edge.target]?.status), style: { stroke: "#69704f", strokeWidth: 2 } })) ?? [];
    const showRun = (id: string) => perform(async () => {
        if (!await leaveDraft()) return;
        const result = await api<{ run: PublicRun }>(`/api/workflows/runs/${id}`);
        setRun(result.run); setGraph(result.run.graph); setWorkflow(workflows.find(w => w.id === result.run.workflowId) ?? null); setName(result.run.name); setSelected(null); updateUrl(result.run.workflowId, result.run.id);
    });
    const editWorkflow = () => { if (workflow) { setRun(null); setGraph(workflow.graph); setName(workflow.name); updateUrl(workflow.id); } };

    return <main className="wf-studio">
        <header className="wf-header">
            <button className="wf-icon-button" aria-label="Volver al Studio" onClick={async () => { if (await leaveDraft()) onBack(); }}><ArrowLeft size={18} /></button>
            <div className="wf-brand"><WorkflowIcon size={22} /><div><strong>Workflows</strong><span>Tu proceso creativo, conectado.</span></div></div>
            <span className="wf-storage">{storage} · privado</span>
            <button type="button" className="wf-button" onClick={() => setUsageOpen(true)}>Consumo</button>
        </header>
        <div className="wf-layout">
            <aside className="wf-sidebar">
                <button type="button" className="wf-button wf-primary" disabled={busy || loading} onClick={createWorkflow}><Plus size={16} /> Nuevo workflow</button>
                <button type="button" className="wf-button" disabled={busy || loading || !graph} onClick={async () => {
                    if (!await leaveDraft()) return;
                    setGraph(null); setWorkflow(null); setRun(null); setSelected(null); setConfirm(null); setError(""); setNotice(""); updateUrl();
                }}>Ver plantillas</button>
                <h2>MIS WORKFLOWS</h2>
                {!workflows.length && <p className="wf-muted">Tus procesos guardados aparecerán aquí.</p>}
                {workflows.map(w => <button className={`wf-list-item ${workflow?.id === w.id ? "wf-list-active" : ""}`} key={w.id} onClick={() => open(w)}><WorkflowIcon size={15} /><span>{w.name}<small>{w.graph.nodes.length} bloques · v{w.revision}</small></span></button>)}
                {graph && !run && <><h2>AÑADIR BLOQUE</h2><div className="wf-palette">{Object.entries(kindLabels).map(([kind, label]) => <button key={kind} onClick={() => addNode(kind as NodeKind)}><Plus size={13} />{label}</button>)}</div></>}
                <h2>EJECUCIONES RECIENTES</h2>
                {runs.filter(r => !workflow || r.workflowId === workflow.id).slice(0, 12).map(r => <button className="wf-list-item" key={r.id} onClick={() => void showRun(r.id)}><span>{r.name}<small>{statusLabels[r.id === run?.id ? run.status : r.status]} · {new Date(r.createdAt).toLocaleString()}</small></span></button>)}
                <p className="wf-sidebar-note">Tus APIs se administran en Studio → APIs. No se copian claves a los bloques.</p>
            </aside>
            <section className="wf-workspace">
                {error && <div className="wf-alert" role="alert">{error}<button aria-label="Cerrar error" onClick={() => setError("")}><X size={15} /></button></div>}
                {notice && <div className="wf-notice" role="status">{notice}</div>}
                {!graph ? <div className="wf-welcome"><span className="wf-eyebrow">DE LA IDEA AL RESULTADO</span><h1>Conecta tus ideas.<br /><em>Diseña tu proceso.</em></h1><p>Combina prompts, imágenes y video en un lienzo. Revisa cada resultado antes de dar el siguiente paso.</p><div className="wf-template-grid">{templates.map(t => <button key={t.id} className="wf-template" disabled={loading} onClick={() => newTemplate(t.id)}><span>{t.badge}</span><h3>{t.name}</h3><p>{t.description}</p><strong>{loading ? "Cargando conexiones…" : "Usar plantilla"} ↗</strong></button>)}</div><p className="wf-muted">OpenRouter y Higgsfield · API.market pendiente de contratos por producto</p></div> : <>
                    <div className="wf-toolbar"><input aria-label="Nombre del workflow" value={name} disabled={!!run} maxLength={100} onChange={e => setName(e.target.value)} /><span className="wf-draft">{run ? `${statusLabels[run.status]} · v${run.revision}` : dirty ? "Sin guardar" : `Guardado · v${workflow?.revision}`}</span><div className="wf-toolbar-actions">
                        {run ? <><button className="wf-button" onClick={editWorkflow}>Editar workflow</button>{["queued", "running", "approval"].includes(run.status) && <button className="wf-button" disabled={busy} onClick={() => void action("cancel")}><Square size={14} />Detener</button>}</> : <>
                            <button className="wf-button" disabled={busy} onClick={() => void perform(async () => { await save(); })}><Save size={15} />Guardar</button>
                            <button className="wf-icon-button" title="Duplicar workflow" aria-label="Duplicar workflow" disabled={busy} onClick={() => { setWorkflow(null); setName(`${name} (copia)`); updateUrl(); }}><Copy size={16} /></button>
                            <button className="wf-button wf-primary" disabled={busy || loading} onClick={() => setConfirm({ key: crypto.randomUUID() })}><Play size={15} />Ejecutar</button>
                        </>}
                    </div></div>
                    <div className="wf-editor">
                        <div className="wf-canvas"><ReactFlow<CanvasNode, Edge> key={workflow?.id ?? `draft-${draftVersion}`} nodes={canvasNodes} edges={edges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance; }} onNodeClick={(_event, node) => setSelected(node.id)} onPaneClick={() => setSelected(null)} onConnect={connect} nodesDraggable={!run} nodesConnectable={!run} edgesReconnectable={false} deleteKeyCode={run ? null : "Delete"} onNodesChange={changes => {
                            const measured = changes.filter(c => c.type === "dimensions");
                            if (measured.length) setDimensions(current => {
                                const next = { ...current }; let changed = false;
                                for (const change of measured) if (change.dimensions && (current[change.id]?.width !== change.dimensions.width || current[change.id]?.height !== change.dimensions.height)) { next[change.id] = change.dimensions; changed = true; }
                                return changed ? next : current;
                            });
                            const edits = changes.filter(c => c.type === "position" || c.type === "remove");
                            if (run || !edits.length) return;
                            const updated = applyNodeChanges(edits, canvasNodes);
                            setGraph(current => current ? { ...current, nodes: updated.map(n => ({ ...n.data.node, position: n.position })), edges: current.edges.filter(e => updated.some(n => n.id === e.source) && updated.some(n => n.id === e.target)) } : current);
                        }} onEdgesChange={changes => { if (!run) setGraph(current => current ? { ...current, edges: applyEdgeChanges(changes, edges).map(({ id, source, target, targetHandle }) => ({ id, source, target, targetHandle: targetHandle ?? "input" })) } : current); }} fitView fitViewOptions={{ padding: 0.3, maxZoom: 0.85 }} minZoom={0.2} maxZoom={1.6} colorMode="dark"><Background color="#30332b" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="#5c6742" maskColor="rgba(0,0,0,.45)" /></ReactFlow><div className="wf-canvas-hint">{run ? "Ejecución guardada · el servidor continúa aunque cierres esta pestaña" : "Arrastra para organizar · une los puntos para conectar · selecciona para configurar"}</div></div>
                        <aside className="wf-inspector">
                            {!activeNode ? <><span className="wf-eyebrow">INSPECTOR</span><h3>{run ? "Sigue tu ejecución" : "Todo empieza con un bloque"}</h3><p className="wf-muted">Selecciona un bloque para {run ? "ver su resultado o aprobarlo." : "elegir modelo, escribir un prompt y ajustar sus entradas."}</p>{run && <div className="wf-log">{run.events.slice(-12).reverse().map((entry, i) => <p key={i}><small>{new Date(entry.at).toLocaleTimeString()}</small>{entry.message}</p>)}</div>}</> : <>
                                <div className="wf-inspector-title"><span className="wf-eyebrow">{kindLabels[activeNode.kind]}</span><button aria-label="Cerrar inspector" onClick={() => setSelected(null)}><X size={16} /></button></div>
                                <label>Nombre<input value={activeNode.label} disabled={!!run} maxLength={80} onChange={e => patchNode({ label: e.target.value })} /></label>
                                {["image", "video"].includes(activeNode.kind) && <><label>Modelo y conexión<select value={activeNode.config.modelId ?? ""} disabled={!!run} onChange={e => { patchNode({ config: { text: activeNode.config.text, modelId: e.target.value, params: {} } }); }}><option value="">Selecciona un modelo</option>{models.filter(m => m.mediaType === activeNode.kind).map(m => <option key={m.id} value={m.id}>{m.group} · {m.label} · {m.provider_connection_id?.slice(0, 8)}</option>)}</select></label>{!models.some(m => m.mediaType === activeNode.kind) && <p className="wf-warning">No hay modelos disponibles. Revisa tu conexión en Studio → APIs y vuelve a entrar.</p>}{activeCap?.provider === "higgsfield" && activeCap.provider_model_id?.includes("text-to-video") && <p className="wf-warning">Este endpoint admite texto a video; no conectes imágenes.</p>}</>}
                                {["prompt", "image", "video"].includes(activeNode.kind) && <label>{activeNode.kind === "prompt" ? "Texto" : "Prompt (si no hay uno conectado)"}<textarea rows={6} value={activeNode.config.text ?? ""} disabled={!!run} maxLength={10000} onChange={e => patchNode({ config: { ...activeNode.config, text: e.target.value } })} placeholder="Describe lo que quieres crear…" /></label>}
                                {activeCap && parameterOptions(activeCap).map(field => <label key={field.id}>{field.label}{field.type === "select" ? <select disabled={!!run} value={String(activeNode.config.params?.[field.id] ?? "")} onChange={e => { const params = { ...activeNode.config.params }; if (e.target.value) params[field.id] = e.target.value; else delete params[field.id]; patchNode({ config: { ...activeNode.config, params } }); }}><option value="">Predeterminado del proveedor</option>{field.options?.map(v => <option key={v} value={v}>{v}</option>)}</select> : field.type === "checkbox" ? <select disabled={!!run} value={String(activeNode.config.params?.[field.id] ?? "")} onChange={e => { const params = { ...activeNode.config.params }; if (e.target.value) params[field.id] = e.target.value === "true"; else delete params[field.id]; patchNode({ config: { ...activeNode.config, params } }); }}><option value="">Predeterminado</option><option value="true">Sí</option><option value="false">No</option></select> : <input disabled={!!run} type={field.type === "number" ? "number" : "text"} min={field.minimum} max={field.maximum} value={String(activeNode.config.params?.[field.id] ?? "")} onChange={e => { const params = { ...activeNode.config.params }; if (e.target.value) params[field.id] = field.type === "number" ? Number(e.target.value) : e.target.value; else delete params[field.id]; patchNode({ config: { ...activeNode.config, params } }); }} />}</label>)}
                                {activeNode.kind === "image" && activeCap && !run && <GenerationPrice key={activeCap.id} model={activeCap} resolution={String(activeNode.config.params?.resolution || "")} aspectRatio={String(activeNode.config.params?.aspect_ratio || "")} quality={String(activeNode.config.params?.quality || "")} size={String(activeNode.config.params?.size || "")} count={Number(activeNode.config.params?.n ?? 1)} />}
                                {activeNode.kind === "asset" && <><label className="wf-upload"><Upload size={18} />{busy ? "Subiendo…" : "Subir imagen"}<input type="file" disabled={!!run || busy} accept="image/png,image/jpeg,image/webp,image/avif" onChange={e => { const file = e.target.files?.[0]; if (!file) return; void perform(async () => { if (file.size > 20 * 1024 * 1024) throw new Error("Máximo 20 MB por imagen."); const response = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": file.type }, body: file }); const result = await response.json(); if (!response.ok) throw new Error(result.error); patchNode({ config: { assetId: result.asset.id } }); await refresh(); }); }} /></label><label>O usar un resultado guardado<select disabled={!!run} value={activeNode.config.assetId ?? ""} onChange={e => patchNode({ config: { assetId: e.target.value || undefined } })}><option value="">Selecciona una imagen</option>{assets.filter(a => a.kind === "image").map(a => <option key={a.id} value={a.id}>{new Date(a.createdAt).toLocaleString()} · {a.id.slice(0, 8)}</option>)}</select></label></>}
                                {["approval", "output"].includes(activeNode.kind) && <label>Tipo de entrada<select disabled={!!run} value={activeNode.config.valueKind ?? "image"} onChange={e => patchNode({ config: { valueKind: e.target.value as "text" | "image" | "video" } })}><option value="text">Texto</option><option value="image">Imagen</option><option value="video">Video</option></select></label>}
                                {activeState && <div className={`wf-status wf-status-${activeState.status}`}>{statusLabels[activeState.status]}</div>}
                                {activeState?.value?.text && <p className="wf-text-result">{activeState.value.text}</p>}
                                {activeState?.value?.assetIds?.map(id => <div className="wf-result" key={id}>{activeState.value.kind === "video" ? <video controls src={`/api/workflows/assets/${id}`} /> : <img src={`/api/workflows/assets/${id}`} alt="Resultado generado" />}<a className="wf-button" href={`/api/workflows/assets/${id}?download=1`}><Download size={15} />Descargar</a></div>)}
                                {activeState?.error && <p className="wf-warning">{activeState.error}</p>}
                                {activeState?.status === "approval" && <button className="wf-button wf-primary" disabled={busy} onClick={() => void action("approve", activeNode.id)}><CircleCheck size={16} />Aprobar y continuar</button>}
                                {activeState?.status === "review" && activeState.providerTaskId && <button className="wf-button" disabled={busy} onClick={() => void action("resume", activeNode.id)}>Volver a consultar (sin generar)</button>}
                                {!run && <><h4>CONEXIONES DE ENTRADA</h4>{graph.edges.filter(e => e.target === selected).map(e => <div className="wf-connection" key={e.id}><span>{graph.nodes.find(n => n.id === e.source)?.label} → {e.targetHandle.replace("slot:", "")}</span><button aria-label="Eliminar conexión" onClick={() => setGraph({ ...graph, edges: graph.edges.filter(edge => edge.id !== e.id) })}><X size={13} /></button></div>)}<button className="wf-button" disabled={busy} onClick={() => setConfirm({ targetId: activeNode.id, key: crypto.randomUUID() })}><Play size={14} />Ejecutar hasta este bloque</button><button className="wf-delete" onClick={() => { setGraph({ ...graph, nodes: graph.nodes.filter(n => n.id !== selected), edges: graph.edges.filter(e => e.source !== selected && e.target !== selected) }); setSelected(null); }}>Eliminar bloque</button></>}
                            </>}
                        </aside>
                    </div>
                </>}
            </section>
        </div>
        {confirm && graph && <div className="wf-modal-backdrop"><section className="wf-modal" role="dialog" aria-modal="true" aria-labelledby="wf-confirm-title"><span className="wf-eyebrow">REVISAR EJECUCIÓN</span><h2 id="wf-confirm-title">{confirm.targetId ? "Ejecutar hasta el bloque seleccionado" : "Ejecutar workflow"}</h2><p>Se ejecutarán <strong>{executionGraph(graph, confirm.targetId).nodes.filter(n => ["image", "video"].includes(n.kind)).length} bloques de generación</strong>. El coste exacto no está disponible; cada proveedor cobra según su modelo.</p><p>Los pasos de aprobación pausarán el flujo. Cada nueva ejecución vuelve a generar sus dependencias; no reutiliza resultados anteriores automáticamente.</p><p className="wf-muted">Límite: 6 generaciones por ejecución · una solicitud a la vez. Detener no anula cargos de solicitudes ya enviadas.</p>{error && <p className="wf-warning" role="alert">{error}</p>}<div className="wf-modal-actions"><button className="wf-button" disabled={busy} onClick={() => setConfirm(null)}>Volver</button><button className="wf-button wf-primary" disabled={busy} onClick={() => void launch()}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}Confirmar ejecución</button></div></section></div>}
        <UsagePanel open={usageOpen} onOpenChange={setUsageOpen} />
        <Dialog open={!!discardRequest} onOpenChange={open => { if (!open) resolveDiscard(false); }}>
            <DialogContent showCloseButton={false} className="border border-[#485a37] bg-[#172011] p-6 text-[#eff2e9] sm:max-w-md">
                <DialogTitle>Hay cambios sin guardar</DialogTitle>
                <DialogDescription className="text-[#b1c29e]">Puedes seguir editando o descartar este borrador para continuar. Tus workflows guardados no se eliminarán.</DialogDescription>
                <div className="mt-3 flex justify-end gap-3">
                    <button type="button" className="rounded-lg border border-[#485a37] px-4 py-2" onClick={() => resolveDiscard(false)}>Seguir editando</button>
                    <button type="button" className="rounded-lg bg-[#d5ff47] px-4 py-2 font-medium text-[#202809]" onClick={() => resolveDiscard(true)}>Descartar y continuar</button>
                </div>
            </DialogContent>
        </Dialog>
    </main>;
}
