"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, Pencil, Plus, Server, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import type { PublicProviderConnection } from "@/lib/connection-store";
import { parseApiMarketProducts, type ApiMarketProduct } from "@/lib/api-market-products";
import { AdminAccess } from "./AdminAccess";

type Provider = "openrouter" | "openai" | "elevenlabs" | "higgsfield" | "api-market" | "apimart" | "deepseek";
const names = { openrouter: "OpenRouter", openai: "OpenAI", elevenlabs: "ElevenLabs", higgsfield: "Higgsfield", "api-market": "API.market", apimart: "APIMart", deepseek: "DeepSeek" };
const AVAILABLE_PROVIDERS: Provider[] = ["openrouter", "openai", "elevenlabs", "apimart", "deepseek"];
const providerHints: Record<Provider, string> = {
    openrouter: "Imagen, vídeo y audio",
    openai: "Edición de imágenes",
    elevenlabs: "Voces y clonación",
    higgsfield: "Imagen y vídeo creativos",
    "api-market": "Productos MCP suscritos",
    apimart: "Modelos visuales unificados",
    deepseek: "Chat, razonamiento y búsqueda web",
};
const empty = { provider: "openrouter" as Provider, name: "", apiKey: "", workspace: "", slug: "", mediaType: "image", toolName: "", statusToolName: "", enabled: true, isDefault: true };

export function AdminConnectionsPanel({ onBack }: { onBack: () => void }) {
    const [connections, setConnections] = useState<PublicProviderConnection[]>([]);
    const [form, setForm] = useState(empty);
    const [id, setId] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [changePassword, setChangePassword] = useState(false);
    const [tested, setTested] = useState(false);
    const [marketMode, setMarketMode] = useState<"catalog" | "product">("catalog");
    const [marketProducts, setMarketProducts] = useState<ApiMarketProduct[]>([]);
    const [discoveredProducts, setDiscoveredProducts] = useState<ApiMarketProduct[]>([]);
    const [productQuery, setProductQuery] = useState("");
    const load = useCallback(async () => {
        const response = await fetch("/api/admin/connections", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No se pudieron cargar las conexiones.");
        setConnections(data.connections);
    }, []);
    useEffect(() => {
        const timer = window.setTimeout(() => { void load().catch((error) => setMessage(error.message)); }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);
    function reset() { setForm(empty); setId(undefined); setTested(false); setMarketMode("catalog"); setMarketProducts([]); setDiscoveredProducts([]); setProductQuery(""); }
    function change(key: keyof typeof empty, value: string | boolean) { setForm((previous) => ({ ...previous, [key]: value })); setTested(false); }
    function edit(connection: PublicProviderConnection) {
        setId(connection.id); setTested(false); setMessage("");
        setMarketMode(connection.config.mode === "catalog" ? "catalog" : "product");
        try { setMarketProducts(connection.config.mode === "catalog" ? parseApiMarketProducts(connection.config.products || "[]") : []); }
        catch { setMarketProducts([]); }
        setDiscoveredProducts([]);
        setProductQuery("");
        setForm({ ...empty, provider: connection.provider as Provider, name: connection.name, workspace: connection.config.workspace || "", slug: connection.config.slug || "", mediaType: connection.config.mediaType || "image", toolName: connection.config.toolName || "", statusToolName: connection.config.statusToolName || "", enabled: connection.enabled, isDefault: connection.isDefault });
    }
    async function discoverProducts() {
        setBusy(true); setMessage("");
        try {
            const response = await fetch("/api/admin/api-market/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(id ? { id } : {}), ...(form.apiKey ? { apiKey: form.apiKey } : {}) }) });
            const data = await response.json() as { products?: ApiMarketProduct[]; error?: string };
            if (!response.ok) throw new Error(data.error || "No se pudieron consultar las suscripciones.");
            setDiscoveredProducts(data.products ?? []);
            if (!data.products?.length) setMessage("No aparecen suscripciones activas. Puedes añadir un producto manualmente si conoces su URL MCP.");
        } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudieron consultar las suscripciones."); }
        finally { setBusy(false); }
    }
    function toggleProduct(product: ApiMarketProduct) {
        setMarketProducts((current) => current.some((item) => item.workspace === product.workspace && item.slug === product.slug)
            ? current.filter((item) => item.workspace !== product.workspace || item.slug !== product.slug)
            : current.length < 30 ? [...current, product] : current);
        setTested(false);
    }
    function addManualProduct() {
        const workspace = form.workspace.trim(); const slug = form.slug.trim();
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspace) || !/^[a-zA-Z0-9_-]{1,150}$/.test(slug)) { setMessage("Introduce el workspace y slug que figuran en la URL MCP del producto."); return; }
        setMarketProducts((current) => current.some((item) => item.workspace === workspace && item.slug === slug) ? current : current.length < 30 ? [...current, { workspace, slug, mediaType: form.mediaType as ApiMarketProduct["mediaType"] }] : current);
        setForm((current) => ({ ...current, workspace: "", slug: "" })); setMessage("");
    }
    async function save(test: boolean) {
        setBusy(true); setMessage("");
        try {
            const config = form.provider === "api-market" ? marketMode === "catalog"
                ? { mode: "catalog", products: JSON.stringify(marketProducts) }
                : { workspace: form.workspace, slug: form.slug, mediaType: form.mediaType, ...(form.toolName ? { toolName: form.toolName } : {}), ...(form.statusToolName ? { statusToolName: form.statusToolName } : {}) } : {};
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
            reset(); setConnections([]); onBack();
            window.dispatchEvent(new Event("open-higgsfield:auth-updated"));
        } catch (error) { setMessage((error as Error).message); }
        finally { setBusy(false); }
    }
    const input = "mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-[#ff4d4d] focus:ring-2 focus:ring-[#ff4d4d]/15";
    const button = "rounded-xl border border-white/15 px-3.5 py-2.5 text-sm font-medium transition hover:border-[#ff4d4d]/55 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40";
    return <main className="h-dvh overflow-y-auto overscroll-contain bg-[#080808] px-4 pb-16 pt-24 text-white sm:px-8">
        <section aria-label="Conexiones de APIs" className="mx-auto w-full max-w-7xl">
            <header className="mb-7 flex flex-col gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-[#ff4d4d]">Administración del Studio</p><h1 className="mt-2 flex items-center gap-3 text-3xl font-bold tracking-tight"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#c62828] text-white shadow-[0_10px_35px_rgba(198,40,40,.24)]"><Settings2 size={22} /></span> APIs y conexiones</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">Conecta proveedores, prueba el acceso y administra los modelos disponibles desde un único espacio seguro.</p></div><div className="flex items-center gap-3"><span className="hidden rounded-full border border-white/10 bg-white/[.03] px-3 py-2 text-xs text-white/45 sm:inline-flex">{connections.length} {connections.length === 1 ? "conexión" : "conexiones"}</span><button type="button" onClick={onBack} className={`${button} flex items-center gap-2`}><ArrowLeft size={17} /> Inicio</button></div></header>
            {changePassword ? <div className="mx-auto max-w-2xl rounded-[28px] border border-white/10 bg-[#111] p-5 sm:p-7"><AdminAccess changePassword onReady={() => { setChangePassword(false); setMessage("Contraseña actualizada. Las sesiones anteriores se han cerrado."); }} /><button className={`${button} mt-4`} onClick={() => setChangePassword(false)}>Volver a conexiones</button></div> : <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="min-w-0 space-y-6">
                    <section className="rounded-[28px] border border-white/10 bg-[#111] p-5 sm:p-6"><div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Añadir proveedor</h2><p className="mt-1 text-xs text-white/45">Elige el servicio que quieres conectar.</p></div><Server size={20} className="text-white/25" /></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{AVAILABLE_PROVIDERS.map((provider) => <button key={provider} type="button" disabled={busy} className={`group min-h-28 rounded-2xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-[#ff4d4d] ${form.provider === provider ? "border-[#ff4d4d]/70 bg-[#ff4d4d]/10 shadow-[inset_0_0_0_1px_rgba(255,77,77,.12)]" : "border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/[.035]"}`} onClick={() => { reset(); setForm({ ...empty, provider }); setMessage(""); }}><span className={`grid h-8 w-8 place-items-center rounded-xl ${form.provider === provider ? "bg-[#c62828] text-white" : "bg-white/5 text-white/60 group-hover:text-white"}`}><Plus size={16} /></span><span className="mt-3 block text-sm font-semibold">{names[provider]}</span><span className="mt-1 block text-[11px] leading-relaxed text-white/45">{providerHints[provider]}</span></button>)}</div></section>
                    <form onSubmit={(event) => { event.preventDefault(); void save(false); }} className="space-y-5 rounded-[28px] border border-white/10 bg-[#111] p-5 shadow-2xl shadow-black/20 sm:p-7">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5"><div><p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#ff4d4d]">{id ? "Configuración existente" : "Nueva conexión"}</p><h2 className="mt-1 text-xl font-semibold">{names[form.provider]}</h2></div>{id && <button type="button" className={`${button} text-white/65`} onClick={reset}>Cancelar edición</button>}</div>
                    <fieldset disabled={busy} className="space-y-4">
                        <label className="block text-sm">Nombre<input className={input} value={form.name} onChange={(event) => change("name", event.target.value)} placeholder={names[form.provider]} maxLength={80} /></label>
                        <label className="block text-sm">API key<input type="password" autoComplete="off" className={input} value={form.apiKey} onChange={(event) => change("apiKey", event.target.value)} placeholder={id ? "Vacío para conservar la clave guardada" : "Pega tu clave de API"} required={!id} maxLength={4096} /></label>
                        {form.provider === "apimart" && <p className="rounded-xl border border-[#ff4d4d]/25 bg-[#ff4d4d]/5 p-3 text-xs leading-relaxed text-white/65">Pega una clave creada en APIMart. El catálogo de modelos de imagen y vídeo se consulta automáticamente al guardar; no requiere workspace ni slug.</p>}
                        {form.provider === "api-market" && <div className="space-y-4">
                            <div className="flex flex-wrap gap-2" role="group" aria-label="Modo de API.market"><button type="button" className={`${button} ${marketMode === "catalog" ? "border-[#ff4d4d] bg-[#ff4d4d]/10" : ""}`} onClick={() => setMarketMode("catalog")}>Varios modelos</button><button type="button" className={`${button} ${marketMode === "product" ? "border-[#ff4d4d] bg-[#ff4d4d]/10" : ""}`} onClick={() => setMarketMode("product")}>Producto individual · avanzado</button></div>
                            {marketMode === "catalog" ? <>
                                <p className="text-xs leading-relaxed text-white/60">Una clave para varios productos. Consulta tus suscripciones y elige cuáles aparecerán en los selectores de imagen y vídeo. La clave queda cifrada en el servidor.</p>
                                <button type="button" className={button} disabled={busy || (!id && !form.apiKey)} onClick={() => void discoverProducts()}>{busy ? "Consultando…" : "Buscar mis productos en API.market"}</button>
                                {discoveredProducts.length > 0 && <><label className="block text-xs text-white/60">Filtrar productos<input className={input} value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="Ej. image, video, flux" /></label><div className="max-h-52 space-y-2 overflow-y-auto rounded-xl border border-white/10 p-2" aria-label="Productos de API.market disponibles">{discoveredProducts.filter((product) => `${product.workspace}/${product.slug}`.toLowerCase().includes(productQuery.toLowerCase())).map((product) => { const key = `${product.workspace}/${product.slug}`; const selected = marketProducts.some((item) => item.workspace === product.workspace && item.slug === product.slug); return <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg p-2 text-xs hover:bg-white/5"><input type="checkbox" checked={selected} onChange={() => toggleProduct(product)} /><span className="min-w-0 break-all">{key}</span></label>; })}</div></>}
                                {marketProducts.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold text-white/75">Modelos elegidos ({marketProducts.length})</p>{marketProducts.map((product) => <div key={`${product.workspace}/${product.slug}`} className="flex items-center gap-2 rounded-xl border border-white/10 p-2 text-xs"><span className="min-w-0 flex-1 break-all">{product.workspace}/{product.slug}</span><select aria-label={`Tipo de ${product.slug}`} value={product.mediaType} onChange={(event) => setMarketProducts((current) => current.map((item) => item.workspace === product.workspace && item.slug === product.slug ? { ...item, mediaType: event.target.value as ApiMarketProduct["mediaType"] } : item))} className="rounded-lg border border-white/15 bg-[#181818] px-2 py-1 text-white"><option value="image">Imagen</option><option value="video">Vídeo</option><option value="both">Ambos</option></select><button type="button" aria-label={`Quitar ${product.slug}`} onClick={() => toggleProduct(product)} className="rounded p-1 text-white/50 hover:text-red-300"><X className="h-4 w-4" /></button></div>)}</div>}
                                <details className="text-xs"><summary className="cursor-pointer text-white/60">Añadir producto por URL MCP (si no aparece en mis suscripciones)</summary><div className="mt-3 grid gap-2 sm:grid-cols-2"><label>Workspace<input className={input} value={form.workspace} onChange={(event) => change("workspace", event.target.value)} placeholder="magicapi" /></label><label>Slug<input className={input} value={form.slug} onChange={(event) => change("slug", event.target.value)} placeholder="ideogram-v3-pro-text-to-image" /></label></div><label className="mt-2 block">Tipo<select className={input} value={form.mediaType} onChange={(event) => change("mediaType", event.target.value)}><option value="image">Imagen</option><option value="video">Vídeo</option><option value="both">Ambos</option></select></label><button type="button" className={`${button} mt-2`} onClick={addManualProduct}>Añadir producto</button></details>
                            </> : <><p className="text-xs text-white/50">Configuración anterior: un producto por conexión. Copia el workspace y slug desde la URL MCP del producto.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Workspace<input className={input} value={form.workspace} onChange={(event) => change("workspace", event.target.value)} required /></label><label className="text-sm">Slug del producto<input className={input} value={form.slug} onChange={(event) => change("slug", event.target.value)} required /></label></div><label className="block text-sm">Tipo de generación<select className={input} value={form.mediaType} onChange={(event) => change("mediaType", event.target.value)}><option value="image">Imagen</option><option value="video">Video</option><option value="both">Ambos</option></select></label><details className="text-sm"><summary className="cursor-pointer text-white/60">Herramientas del producto (avanzado)</summary><label className="mt-2 block">Herramienta de generación<input className={input} value={form.toolName} onChange={(event) => change("toolName", event.target.value)} placeholder="Descubrir automáticamente" /></label><label className="mt-2 block">Herramienta de estado<input className={input} value={form.statusToolName} onChange={(event) => change("statusToolName", event.target.value)} placeholder="Para trabajos asíncronos" /></label></details></>}
                        </div>}
                        <div className="flex flex-wrap gap-4 text-sm"><label className="flex gap-2"><input type="checkbox" checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)} />Activada</label><label className="flex gap-2"><input type="checkbox" checked={form.isDefault} onChange={(event) => change("isDefault", event.target.checked)} />Predeterminada del proveedor</label></div>
                        <div className="flex flex-wrap gap-2 border-t border-white/10 pt-5"><button type="button" className={button} disabled={!id && !form.apiKey} onClick={() => void save(true)}>{tested ? "✓ Conexión comprobada" : "Probar conexión"}</button><button type="submit" disabled={form.provider === "api-market" && marketMode === "catalog" && !marketProducts.length} className="inline-flex items-center justify-center rounded-xl bg-[#c62828] px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(198,40,40,.2)] transition hover:bg-[#dc3030] disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar conexión"}</button></div>
                    </fieldset>
                </form>
                </div>
                <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
                    <section className="rounded-[28px] border border-white/10 bg-[#111] p-5 shadow-2xl shadow-black/20"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Conexiones</h2><p className="mt-1 text-xs text-white/45">Proveedores configurados</p></div><span className="grid h-8 min-w-8 place-items-center rounded-full bg-white/5 px-2 text-xs text-white/60">{connections.length}</span></div><div className="space-y-3">{connections.length === 0 && <div className="rounded-2xl border border-dashed border-white/15 bg-black/20 p-4 text-sm leading-relaxed text-white/45">Aún no hay proveedores conectados. Elige uno en la sección principal.</div>}{connections.map((connection) => <article key={connection.id} className={`rounded-2xl border p-3.5 transition ${id === connection.id ? "border-[#ff4d4d]/70 bg-[#ff4d4d]/[.06]" : "border-white/10 bg-black/20"}`}><div className="flex gap-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${connection.enabled ? "bg-emerald-400" : "bg-white/25"}`} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{connection.name}</p><p className="mt-1 text-xs text-white/45">{names[connection.provider as Provider]}{connection.isDefault ? " · Predeterminada" : ""}</p><p className="mt-1.5 text-[11px] text-white/35">{connection.lastTestedAt ? `Comprobada ${new Date(connection.lastTestedAt).toLocaleDateString()}` : "Sin comprobación guardada"}</p></div></div><div className="mt-3 flex gap-2"><button type="button" className={`${button} flex-1 !px-2.5 !py-2 text-xs`} disabled={busy} onClick={() => edit(connection)}><Pencil className="mr-1.5 inline h-3.5 w-3.5" />Editar</button><button type="button" aria-label={`Eliminar ${connection.name}`} className={`${button} !px-2.5 !py-2 text-red-200 hover:border-red-400/50 hover:bg-red-500/10`} disabled={busy} onClick={() => void remove(connection)}><Trash2 className="h-3.5 w-3.5" /></button></div></article>)}</div></section>
                    <section className="rounded-[28px] border border-white/10 bg-black/20 p-5"><div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#c62828]/15 text-[#ff6565]"><ShieldCheck size={19} /></span><div><h2 className="text-sm font-semibold">Claves protegidas</h2><p className="mt-1.5 text-xs leading-relaxed text-white/50">Las credenciales se cifran antes de guardarse y nunca vuelven al navegador después de enviarlas.</p></div></div></section>
                    <section className="rounded-[28px] border border-white/10 bg-[#111] p-5"><div className="mb-4 flex items-center gap-2"><KeyRound size={17} className="text-white/55" /><h2 className="text-sm font-semibold">Cuenta</h2></div><div className="space-y-2"><button type="button" className={`${button} w-full text-left`} onClick={() => { reset(); setChangePassword(true); }}>Cambiar contraseña</button><button type="button" className={`${button} w-full text-left`} disabled={busy} onClick={() => void logout(false)}>Cerrar sesión</button><button type="button" className={`${button} w-full text-left text-red-200 hover:border-red-400/50 hover:bg-red-500/10`} disabled={busy} onClick={() => void logout(true)}>Cerrar todas las sesiones</button></div></section>
                </aside>
            </div>}
            {message && <p role="status" className="mt-6 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[.045] px-4 py-3 text-sm text-white/75"><CheckCircle2 className="h-4 w-4 shrink-0 text-[#ff6565]" />{message}</p>}
        </section>
    </main>;
}
