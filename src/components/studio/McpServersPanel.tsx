"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Clipboard, KeyRound, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import type { ModelCapabilities } from "@/models/capabilities/types";

interface Connection {
    id: string;
    provider: string;
    name: string;
    enabled: boolean;
    isDefault: boolean;
}

interface McpServer {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    connectionId: string;
    imageModelIds: string[];
    videoModelIds: string[];
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string;
}

const empty = { name: "", description: "", enabled: true, connectionId: "", imageModelIds: [] as string[], videoModelIds: [] as string[] };
const input = "mt-1.5 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition focus:border-[#ff4d4d]";
const button = "rounded-xl border border-white/15 px-3 py-2 text-sm text-white/75 transition hover:border-white/30 hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

function providerLabel(provider: string) {
    return ({ openrouter: "OpenRouter", openai: "OpenAI", higgsfield: "Higgsfield", "api-market": "API.market", apimart: "APIMart", freepik: "Freepik", "google-ai-studio": "Google AI Studio", "google-vertex": "Google Vertex", "vercel-ai-gateway": "Vercel AI Gateway" } as Record<string, string>)[provider] ?? provider;
}

export function McpServersPanel({ onBack }: { onBack: () => void }) {
    const [servers, setServers] = useState<McpServer[]>([]);
    const [connections, setConnections] = useState<Connection[]>([]);
    const [images, setImages] = useState<ModelCapabilities[]>([]);
    const [videos, setVideos] = useState<ModelCapabilities[]>([]);
    const [form, setForm] = useState(empty);
    const [editingId, setEditingId] = useState<string>();
    const [busy, setBusy] = useState(true);
    const [message, setMessage] = useState("");
    const [issued, setIssued] = useState<{ id: string; token: string }>();
    const [copied, setCopied] = useState("");

    const load = useCallback(async () => {
        setBusy(true); setMessage("");
        try {
            const [serverResponse, connectionResponse, imageResponse, videoResponse] = await Promise.all([
                fetch("/api/admin/mcp-servers", { cache: "no-store" }),
                fetch("/api/admin/connections", { cache: "no-store" }),
                fetch("/api/catalog?mediaType=image", { cache: "no-store" }),
                fetch("/api/catalog?mediaType=video", { cache: "no-store" }),
            ]);
            const [serverData, connectionData, imageData, videoData] = await Promise.all([serverResponse.json(), connectionResponse.json(), imageResponse.json(), videoResponse.json()]);
            if (!serverResponse.ok) throw new Error(serverData.error || "No se pudieron cargar los MCPs.");
            setServers(serverData.servers ?? []);
            setConnections((connectionData.connections ?? []).filter((item: Connection) => item.enabled));
            setImages(imageData.models ?? []); setVideos(videoData.models ?? []);
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo cargar la configuración."); }
        finally { setBusy(false); }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);
    const selectedConnection = connections.find((item) => item.id === form.connectionId);
    const belongs = useCallback((model: ModelCapabilities) => {
        if (!selectedConnection || model.provider !== selectedConnection.provider) return false;
        if (selectedConnection.provider === "api-market") return true;
        if (model.provider_connection_id) return model.provider_connection_id === selectedConnection.id;
        return selectedConnection.isDefault;
    }, [selectedConnection]);
    const availableImages = useMemo(() => images.filter(belongs), [images, belongs]);
    const availableVideos = useMemo(() => videos.filter(belongs), [videos, belongs]);

    function reset() { setEditingId(undefined); setForm(empty); setIssued(undefined); setMessage(""); }
    function edit(server: McpServer) {
        setEditingId(server.id);
        setForm({ name: server.name, description: server.description, enabled: server.enabled, connectionId: server.connectionId, imageModelIds: server.imageModelIds, videoModelIds: server.videoModelIds });
        setIssued(undefined); setMessage(""); window.scrollTo({ top: 0, behavior: "smooth" });
    }
    function chooseConnection(connectionId: string) {
        setForm((current) => ({ ...current, connectionId, imageModelIds: [], videoModelIds: [] }));
    }
    function toggle(kind: "imageModelIds" | "videoModelIds", id: string) {
        setForm((current) => ({ ...current, [kind]: current[kind].includes(id) ? current[kind].filter((item) => item !== id) : [...current[kind], id] }));
    }
    async function save(rotateToken = false) {
        if (!form.name.trim() || !form.connectionId || (!form.imageModelIds.length && !form.videoModelIds.length)) {
            setMessage("Escribe un nombre, elige una API y selecciona al menos un modelo."); return;
        }
        setBusy(true); setMessage("");
        try {
            const response = await fetch("/api/admin/mcp-servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, ...(editingId ? { id: editingId } : {}), ...(rotateToken ? { rotateToken: true } : {}) }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo guardar el MCP.");
            setServers((current) => editingId ? current.map((item) => item.id === data.server.id ? data.server : item) : [data.server, ...current]);
            if (data.token) setIssued({ id: data.server.id, token: data.token });
            setEditingId(data.server.id); setMessage(rotateToken ? "Token renovado. El anterior dejó de funcionar." : editingId ? "MCP actualizado." : "MCP creado. Guarda el token ahora: solo se mostrará una vez.");
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo guardar el MCP."); }
        finally { setBusy(false); }
    }
    async function remove(server: McpServer) {
        if (!window.confirm(`¿Eliminar “${server.name}”? Sus clientes dejarán de funcionar inmediatamente.`)) return;
        setBusy(true);
        try {
            const response = await fetch(`/api/admin/mcp-servers?id=${encodeURIComponent(server.id)}`, { method: "DELETE" });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || "No se pudo eliminar.");
            setServers((current) => current.filter((item) => item.id !== server.id)); if (editingId === server.id) reset();
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo eliminar."); }
        finally { setBusy(false); }
    }
    async function copy(label: string, value: string) {
        await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(""), 1800);
    }
    const endpoint = issued && typeof window !== "undefined" ? `${window.location.origin}/api/mcp/${issued.id}` : "";
    const configSnippet = issued ? JSON.stringify({ url: endpoint, headers: { "ocp-apim-subscription-key": issued.token } }, null, 2) : "";

    return <main className="h-dvh overflow-y-auto bg-[#070707] px-4 py-6 text-white sm:px-7">
        <section className="mx-auto max-w-7xl pb-16">
            <header className="mb-7 flex flex-wrap items-start justify-between gap-4 pl-14 sm:pl-12"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-[#ff4d4d]">Integraciones</p><h1 className="mt-1 text-2xl font-semibold">Servidores MCP</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-white/50">Crea endpoints independientes para que agentes y aplicaciones generen imágenes o videos usando únicamente las APIs y modelos que autorices.</p></div><button type="button" onClick={onBack} className={`${button} inline-flex items-center gap-2`}><ArrowLeft size={16} />Inicio</button></header>
            {issued && <section className="mb-6 rounded-[28px] border border-emerald-400/25 bg-emerald-400/[.06] p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-emerald-300">Credencial emitida</p><h2 className="mt-1 text-lg font-semibold">Copia el token antes de salir</h2><p className="mt-1 text-xs text-white/50">Por seguridad no volverá a mostrarse. Puedes generar uno nuevo si lo pierdes.</p></div><button type="button" aria-label="Cerrar credencial" onClick={() => setIssued(undefined)} className="rounded-lg p-2 text-white/45 hover:bg-white/5 hover:text-white"><X size={17} /></button></div><div className="mt-4 grid gap-3 lg:grid-cols-2"><div><p className="mb-1 text-xs text-white/45">URL MCP</p><div className="flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75">{endpoint}</code><button type="button" onClick={() => void copy("url", endpoint)} className={button}>{copied === "url" ? <Check size={16} /> : <Clipboard size={16} />}</button></div></div><div><p className="mb-1 text-xs text-white/45">Bearer token</p><div className="flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75">{issued.token}</code><button type="button" onClick={() => void copy("token", issued.token)} className={button}>{copied === "token" ? <Check size={16} /> : <Clipboard size={16} />}</button></div></div></div><details className="mt-4 text-xs"><summary className="cursor-pointer text-white/60">Ver configuración JSON</summary><div className="mt-2 flex gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-3 text-white/70">{configSnippet}</pre><button type="button" onClick={() => void copy("config", configSnippet)} className={`${button} self-start`}>{copied === "config" ? <Check size={16} /> : <Clipboard size={16} />}</button></div></details></section>}
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-6 rounded-[28px] border border-white/10 bg-[#111] p-5 sm:p-7"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5"><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#ff4d4d]">{editingId ? "Editar servidor" : "Nuevo servidor"}</p><h2 className="mt-1 text-xl font-semibold">{editingId ? form.name || "MCP" : "Configurar MCP"}</h2></div>{editingId && <button type="button" onClick={reset} className={button}>Nuevo MCP</button>}</div>
                    <fieldset disabled={busy} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Nombre<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={input} placeholder="Ej. Producción de contenido" maxLength={80} /></label><label className="text-sm">API / conexión<select value={form.connectionId} onChange={(event) => chooseConnection(event.target.value)} className={input}><option value="">Selecciona una conexión</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {providerLabel(connection.provider)}</option>)}</select></label></div><label className="block text-sm">Descripción<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={input} rows={2} maxLength={300} placeholder="Para qué agentes o flujo se usará" /></label>
                    {!connections.length && !busy && <p className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-100">Primero crea y activa una conexión desde el apartado APIs.</p>}
                    {selectedConnection && <div className="grid gap-5 lg:grid-cols-2"><ModelPicker title="Modelos de imagen" models={availableImages} selected={form.imageModelIds} onToggle={(id) => toggle("imageModelIds", id)} /><ModelPicker title="Modelos de video" models={availableVideos} selected={form.videoModelIds} onToggle={(id) => toggle("videoModelIds", id)} /></div>}
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />MCP activado</label><div className="flex flex-wrap gap-2 border-t border-white/10 pt-5"><button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-[#c62828] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#dc3030] disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : editingId ? <Pencil size={16} /> : <Plus size={16} />}{editingId ? "Guardar cambios" : "Crear MCP"}</button>{editingId && <button type="button" onClick={() => { if (window.confirm("El token actual dejará de funcionar. ¿Continuar?")) void save(true); }} className={`${button} inline-flex items-center gap-2`}><RefreshCw size={15} />Renovar token</button>}</div></fieldset>
                </form>
                <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start"><section className="rounded-[28px] border border-white/10 bg-[#111] p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">MCPs creados</h2><p className="mt-1 text-xs text-white/40">{servers.length} configurados</p></div><Server size={19} className="text-white/30" /></div>{busy && !servers.length ? <p className="py-8 text-center text-sm text-white/40">Cargando…</p> : <div className="space-y-3">{servers.map((server) => { const connection = connections.find((item) => item.id === server.connectionId); return <article key={server.id} className={`rounded-2xl border p-4 ${editingId === server.id ? "border-[#ff4d4d]/60 bg-[#ff4d4d]/5" : "border-white/10 bg-black/20"}`}><div className="flex items-start gap-3"><span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${server.enabled ? "bg-emerald-400" : "bg-white/25"}`} /><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{server.name}</h3><p className="mt-1 text-xs text-white/45">{connection?.name || "Conexión no disponible"}</p><p className="mt-1 text-[11px] text-white/35">{server.imageModelIds.length} imagen · {server.videoModelIds.length} video{server.lastUsedAt ? ` · usado ${new Date(server.lastUsedAt).toLocaleDateString()}` : ""}</p></div></div><div className="mt-3 flex gap-2"><button type="button" onClick={() => edit(server)} className={`${button} flex-1 !py-1.5 text-xs`}><Pencil size={13} className="mr-1 inline" />Editar</button><button type="button" aria-label={`Eliminar ${server.name}`} onClick={() => void remove(server)} className={`${button} !py-1.5 text-red-200`}><Trash2 size={14} /></button></div></article>; })}{!servers.length && <p className="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-white/40">Aún no creaste ningún MCP. Cada uno tendrá permisos y token independientes.</p>}</div>}</section><section className="rounded-[28px] border border-white/10 bg-black/20 p-5"><div className="flex gap-3"><KeyRound size={19} className="shrink-0 text-[#ff6565]" /><div><h2 className="text-sm font-semibold">Acceso aislado</h2><p className="mt-1.5 text-xs leading-5 text-white/45">Cada token solo puede usar sus modelos y consultar sus propias generaciones. Desactivar o borrar un MCP corta el acceso.</p></div></div></section></aside>
            </div>{message && <p role="status" className="mt-5 rounded-2xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm text-white/75">{message}</p>}
        </section>
    </main>;
}

function ModelPicker({ title, models, selected, onToggle }: { title: string; models: ModelCapabilities[]; selected: string[]; onToggle: (id: string) => void }) {
    return <section className="rounded-2xl border border-white/10 bg-black/20 p-4"><div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3><span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/45">{selected.length} elegidos</span></div><div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">{models.map((model) => <label key={model.id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-transparent p-2.5 hover:border-white/10 hover:bg-white/[.03]"><input type="checkbox" checked={selected.includes(model.id)} onChange={() => onToggle(model.id)} className="mt-0.5" /><span className="min-w-0"><span className="block text-xs font-medium text-white/85">{model.label}</span><span className="mt-0.5 block truncate text-[10px] text-white/35">{model.group}</span></span></label>)}{!models.length && <p className="py-6 text-center text-xs leading-5 text-white/35">Esta conexión no tiene modelos disponibles para este tipo.</p>}</div></section>;
}
