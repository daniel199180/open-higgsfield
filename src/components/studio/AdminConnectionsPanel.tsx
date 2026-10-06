"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Settings2, X } from "lucide-react";
import type { PublicProviderConnection } from "@/lib/connection-store";
import { AdminAccess } from "./AdminAccess";

type Provider = "openrouter" | "higgsfield" | "api-market";
const names = { openrouter: "OpenRouter", higgsfield: "Higgsfield", "api-market": "API.market" };
const empty = { provider: "openrouter" as Provider, name: "", apiKey: "", workspace: "", slug: "", mediaType: "image", toolName: "", statusToolName: "", enabled: true, isDefault: true };

export function AdminConnectionsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [connections, setConnections] = useState<PublicProviderConnection[]>([]);
    const [form, setForm] = useState(empty);
    const [id, setId] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [changePassword, setChangePassword] = useState(false);
    const [tested, setTested] = useState(false);
    const load = useCallback(async () => {
        const response = await fetch("/api/admin/connections", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No se pudieron cargar las conexiones.");
        setConnections(data.connections);
    }, []);
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => { void load().catch((error) => setMessage(error.message)); }, 0);
        return () => window.clearTimeout(timer);
    }, [open, load]);
    function reset() { setForm(empty); setId(undefined); setTested(false); }
    function change(key: keyof typeof empty, value: string | boolean) { setForm((previous) => ({ ...previous, [key]: value })); setTested(false); }
    function edit(connection: PublicProviderConnection) {
        setId(connection.id); setTested(false); setMessage("");
        setForm({ ...empty, provider: connection.provider as Provider, name: connection.name, workspace: connection.config.workspace || "", slug: connection.config.slug || "", mediaType: connection.config.mediaType || "image", toolName: connection.config.toolName || "", statusToolName: connection.config.statusToolName || "", enabled: connection.enabled, isDefault: connection.isDefault });
    }
    async function save(test: boolean) {
        setBusy(true); setMessage("");
        try {
            const config = form.provider === "api-market" ? { workspace: form.workspace, slug: form.slug, mediaType: form.mediaType, ...(form.toolName ? { toolName: form.toolName } : {}), ...(form.statusToolName ? { statusToolName: form.statusToolName } : {}) } : {};
            const response = await fetch("/api/admin/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, provider: form.provider, name: form.name || names[form.provider], config, credentials: form.apiKey ? { apiKey: form.apiKey } : {}, enabled: form.enabled, isDefault: form.isDefault, test }) });
            const data = await response.json();
            if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event("open-higgsfield:auth-updated")); throw new Error(data.error || "No se pudo guardar."); }
            if (test) { setTested(true); setMessage(data.message); if (id) await load(); }
            else {
                reset(); await load();
                window.dispatchEvent(new Event("open-higgsfield:connections-updated"));
                setMessage("Conexión guardada cifrada en el servidor. Catálogo actualizado.");
            }
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo conectar con el servidor."); }
        finally { setBusy(false); }
    }
    async function remove(connection: PublicProviderConnection) {
        if (!window.confirm(`¿Eliminar ${connection.name}?`)) return;
        setBusy(true);
        try {
            const response = await fetch(`/api/admin/connections/${connection.id}`, { method: "DELETE" });
            if (!response.ok) throw new Error((await response.json()).error);
            if (id === connection.id) reset();
            await load(); window.dispatchEvent(new Event("open-higgsfield:connections-updated"));
            setMessage("Conexión eliminada. Puedes volver a añadirla con tu clave.");
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo eliminar."); }
        finally { setBusy(false); }
    }
    async function logout(all: boolean) {
        setBusy(true);
        try {
            const response = await fetch(`/api/admin/auth${all ? "?all=true" : ""}`, { method: "DELETE" });
            if (!response.ok) throw new Error("No se pudo cerrar la sesión.");
            reset(); setConnections([]); onOpenChange(false);
            window.dispatchEvent(new Event("open-higgsfield:auth-updated"));
        } catch (error) { setMessage((error as Error).message); }
        finally { setBusy(false); }
    }
    if (!open) return null;
    const input = "mt-1 w-full rounded-xl border border-white/15 bg-[#181818] px-3 py-2 text-sm text-white outline-none focus:border-[#d5ff47]";
    const button = "rounded-xl border border-white/15 px-3 py-2 text-sm hover:border-[#d5ff47]/50 disabled:opacity-40";
    return <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4">
        <section role="dialog" aria-modal="true" aria-label="Conexiones de APIs" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-white/10 bg-[#101010] p-5 text-white shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-xl font-bold"><Settings2 className="text-[#d5ff47]" /> Conexiones de APIs</h2><p className="mt-2 text-sm text-white/50">Credenciales cifradas en el servidor. Puedes reemplazarlas sin volver a ver su contenido.</p></div><button aria-label="Cerrar conexiones" onClick={() => { reset(); setChangePassword(false); onOpenChange(false); }} className="p-2"><X /></button></div>
            {changePassword ? <><AdminAccess changePassword onReady={() => { setChangePassword(false); setMessage("Contraseña actualizada. Las sesiones anteriores se han cerrado."); }} /><button className={`${button} mt-3`} onClick={() => setChangePassword(false)}>Volver a conexiones</button></> : <>
                <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">{(Object.keys(names) as Provider[]).map((provider) => <button key={provider} disabled={busy} className={`${button} ${form.provider === provider ? "border-[#d5ff47]/60 bg-[#d5ff47]/10" : ""}`} onClick={() => { reset(); setForm({ ...empty, provider }); setMessage(""); }}>+ {names[provider]}</button>)}</div>
                <form onSubmit={(event) => { event.preventDefault(); void save(false); }} className="space-y-4 rounded-2xl border border-white/10 p-4">
                    <h3 className="font-semibold">{id ? "Editar conexión" : "Nueva conexión"} · {names[form.provider]}</h3>
                    <fieldset disabled={busy} className="space-y-4">
                        <label className="block text-sm">Nombre<input className={input} value={form.name} onChange={(event) => change("name", event.target.value)} placeholder={names[form.provider]} maxLength={80} /></label>
                        <label className="block text-sm">API key<input type="password" autoComplete="off" className={input} value={form.apiKey} onChange={(event) => change("apiKey", event.target.value)} placeholder={id ? "Vacío para conservar la clave guardada" : "Pega tu clave de API"} required={!id} maxLength={4096} /></label>
                        {form.provider === "api-market" && <><p className="text-xs text-white/50">Añade un producto de API.market. Necesitas el workspace y slug que figuran en su documentación.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Workspace<input className={input} value={form.workspace} onChange={(event) => change("workspace", event.target.value)} required /></label><label className="text-sm">Slug del producto<input className={input} value={form.slug} onChange={(event) => change("slug", event.target.value)} required /></label></div><label className="block text-sm">Tipo de generación<select className={input} value={form.mediaType} onChange={(event) => change("mediaType", event.target.value)}><option value="image">Imagen</option><option value="video">Video</option><option value="both">Ambos</option></select></label><details className="text-sm"><summary className="cursor-pointer text-white/60">Herramientas del producto (avanzado)</summary><label className="mt-2 block">Herramienta de generación<input className={input} value={form.toolName} onChange={(event) => change("toolName", event.target.value)} placeholder="Descubrir automáticamente" /></label><label className="mt-2 block">Herramienta de estado<input className={input} value={form.statusToolName} onChange={(event) => change("statusToolName", event.target.value)} placeholder="Para trabajos asíncronos" /></label></details></>}
                        <div className="flex flex-wrap gap-4 text-sm"><label className="flex gap-2"><input type="checkbox" checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)} />Activada</label><label className="flex gap-2"><input type="checkbox" checked={form.isDefault} onChange={(event) => change("isDefault", event.target.checked)} />Predeterminada del proveedor</label></div>
                        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!id && !form.apiKey} onClick={() => void save(true)}>{tested ? "✓ Conexión comprobada" : "Probar conexión"}</button><button type="submit" className="rounded-xl bg-[#d5ff47] px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar conexión"}</button>{id && <button type="button" className={button} onClick={reset}>Cancelar edición</button>}</div>
                    </fieldset>
                </form>
                <div className="mt-5 space-y-2">{connections.length === 0 && <p className="text-sm text-white/50">Todavía no hay conexiones. Añade la primera arriba.</p>}{connections.map((connection) => <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 p-3"><div><p className="font-medium">{connection.name}</p><p className="text-xs text-white/50">{names[connection.provider as Provider]} · {connection.enabled ? "Activada" : "Desactivada"}{connection.isDefault ? " · Predeterminada" : ""}</p><p className="text-xs text-white/40">{connection.lastTestedAt ? `Comprobada: ${new Date(connection.lastTestedAt).toLocaleString()}` : "Sin comprobación guardada"}</p></div><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => edit(connection)}>Editar</button><button className={`${button} text-red-200`} disabled={busy} onClick={() => void remove(connection)}>Eliminar</button></div></div>)}</div>
                <div className="mt-5 flex flex-wrap gap-2 border-t border-white/10 pt-4"><button className={button} onClick={() => { reset(); setChangePassword(true); }}>Cambiar contraseña</button><button className={button} disabled={busy} onClick={() => void logout(false)}>Cerrar sesión</button><button className={button} disabled={busy} onClick={() => void logout(true)}>Cerrar todas las sesiones</button></div>
            </>}
            {message && <p role="status" className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-sm">{message}</p>}
        </section>
    </div>;
}
