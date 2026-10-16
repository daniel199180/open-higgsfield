"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ImagePlus, Loader2, Plus, Save, Trash2, WandSparkles } from "lucide-react";
import type { ImageModelCapability } from "@/models/capabilities/image";
import type { BrandSystem, Character } from "@/social/types";
import { MAX_CHARACTER_REFERENCES } from "@/social/characters";

/* eslint-disable @next/next/no-img-element -- these are private, authenticated asset URLs. */
type Draft = { id?: string; name: string; description: string; visualRules: string; brandId: string; referenceAssetIds: string[]; coverAssetId: string };
const blank: Draft = { name: "", description: "", visualRules: "", brandId: "", referenceAssetIds: [], coverAssetId: "" };
const input = "w-full rounded-xl border border-white/15 bg-[#111] px-3 py-2.5 text-sm text-white outline-none focus:border-[#ff4d4d]";
const red = "rounded-xl bg-[#d92f38] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#ed3c46] disabled:opacity-50";

async function uploadImage(file: Blob): Promise<string> {
    const response = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": file.type || "image/png" }, body: file });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo subir la imagen.");
    return data.asset.id as string;
}

export function CharacterStudio({ onBack }: { onBack: () => void }) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [archivedCharacters, setArchivedCharacters] = useState<Character[]>([]);
    const [brands, setBrands] = useState<BrandSystem[]>([]);
    const [models, setModels] = useState<ImageModelCapability[]>([]);
    const [modelId, setModelId] = useState("");
    const [draft, setDraft] = useState<Draft>(blank);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);

    const load = useCallback(async () => {
        const [characterResponse, socialResponse] = await Promise.all([fetch("/api/characters", { cache: "no-store" }), fetch("/api/social", { cache: "no-store" })]);
        if (!characterResponse.ok || !socialResponse.ok) throw new Error("No se pudo cargar la biblioteca.");
        const [characterData, socialData] = await Promise.all([characterResponse.json(), socialResponse.json()]);
        setCharacters(characterData.characters ?? []);
        setArchivedCharacters(characterData.archivedCharacters ?? []);
        setBrands(socialData.brands ?? []);
    }, []);

    useEffect(() => {
        void load().catch(cause => setError(cause instanceof Error ? cause.message : "Error al cargar."));
        void fetch("/api/catalog?mediaType=image", { cache: "no-store" }).then(response => response.json()).then(data => {
            const suitable = ((data.models ?? []) as ImageModelCapability[]).filter(model =>
                !model.media_slots.some(slot => slot.required) &&
                (model.size_ui?.aspect_ratios.some(ratio => ratio.id === "1:1") ||
                    model.custom_fields?.some(field => field.id === "aspect_ratio" && field.options?.includes("1:1"))));
            setModels(suitable);
            setModelId(current => current || suitable[0]?.id || "");
        }).catch(() => undefined);
    }, [load]);

    const selectedModel = useMemo(() => models.find(model => model.id === modelId), [models, modelId]);
    const save = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); setError("");
        try {
            const response = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", character: {
                ...(draft.id ? { id: draft.id } : {}), name: draft.name, description: draft.description, visualRules: draft.visualRules,
                ...(draft.brandId ? { brandId: draft.brandId } : {}), referenceAssetIds: draft.referenceAssetIds, coverAssetId: draft.coverAssetId,
            } }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo guardar el personaje.");
            await load();
            setDraft({ ...data.character, brandId: data.character.brandId ?? "" });
            window.dispatchEvent(new Event("open-higgsfield:characters-updated"));
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar."); }
        finally { setBusy(false); }
    };

    const addImages = async (files: FileList | null) => {
        if (!files?.length) return;
        const selected = [...files];
        if (draft.referenceAssetIds.length + selected.length > MAX_CHARACTER_REFERENCES) { setError(`Puedes guardar hasta ${MAX_CHARACTER_REFERENCES} referencias.`); return; }
        setBusy(true); setError("");
        try {
            for (const file of selected) {
                const id = await uploadImage(file);
                setDraft(current => ({ ...current, referenceAssetIds: [...current.referenceAssetIds, id], coverAssetId: current.coverAssetId || id }));
            }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron subir las imágenes."); }
        finally { setBusy(false); }
    };

    const generateBase = async () => {
        if (!selectedModel) { setError("Conecta un modelo de imagen que admita formato 1:1."); return; }
        if (!draft.description.trim()) { setError("Describe primero el aspecto del personaje."); return; }
        if (draft.referenceAssetIds.length >= MAX_CHARACTER_REFERENCES) { setError("Quita una referencia antes de generar otra."); return; }
        setBusy(true); setError(""); setProgress("Enviando retrato…");
        try {
            const body = new FormData();
            body.append("prompt", `Crea un retrato de referencia nítido de un solo personaje, sin texto ni logos. Rasgos: ${draft.description}. ${draft.visualRules}. Fondo simple, rostro y vestuario visibles.`);
            body.append("model_id", selectedModel.id);
            body.append("size_aspect", "1:1");
            body.append("size_resolution", selectedModel.size_ui?.default_resolution || String(selectedModel.custom_fields?.find(field => field.id === "resolution")?.default ?? ""));
            body.append("field_values", "{}");
            const response = await fetch("/api/generate-image", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body });
            const result = await response.json();
            if (!response.ok || !result.task_id) throw new Error(result.error || "No se pudo iniciar la generación.");
            let completed = false;
            for (let attempt = 0; attempt < 150; attempt++) {
                await new Promise(resolve => window.setTimeout(resolve, 2000));
                setProgress(`Generando retrato… ${Math.floor((attempt + 1) * 2)} s`);
                const taskResponse = await fetch("/api/image-tasks", { cache: "no-store" });
                if (!taskResponse.ok) continue;
                const tasks = await taskResponse.json() as Array<{ task_id: string; status: string; error_message?: string }>;
                const task = tasks.find(item => item.task_id === result.task_id);
                if (!task) continue;
                if (["FAILED", "ERROR", "CANCELLED"].includes(task.status)) throw new Error(task.error_message || "No se generó el retrato.");
                if (task.status !== "COMPLETED") continue;
                const imageResponse = await fetch(`/api/download/${encodeURIComponent(result.task_id)}?index=0`, { cache: "no-store" });
                if (!imageResponse.ok) throw new Error("No se pudo guardar el retrato generado.");
                const image = await imageResponse.blob();
                const id = await uploadImage(image);
                setDraft(current => ({ ...current, referenceAssetIds: [...current.referenceAssetIds, id], coverAssetId: current.coverAssetId || id }));
                completed = true; break;
            }
            if (!completed) throw new Error("La generación sigue pendiente. El resultado estará en la galería; puedes subirlo después.");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo crear el retrato."); }
        finally { setBusy(false); setProgress(""); }
    };

    const changeArchive = async (character: Character, action: "archive" | "restore") => {
        if (action === "archive" && !window.confirm(`¿Archivar a ${character.name}? Los posteos anteriores conservarán sus referencias.`)) return;
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: character.id }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || "No se pudo archivar.");
            await load(); if (action === "archive" && draft.id === character.id) { setDraft(blank); setOpen(false); }
            window.dispatchEvent(new Event("open-higgsfield:characters-updated"));
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo actualizar el archivo."); }
        finally { setBusy(false); }
    };

    return <main className="min-h-screen bg-black px-5 pb-20 pt-20 text-white md:px-10">
        <div className="mx-auto max-w-6xl">
            <button onClick={onBack} className="mb-8 flex items-center gap-2 text-sm text-white/60 hover:text-white"><ArrowLeft size={16} /> Volver al inicio</button>
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#ff4d4d]">Biblioteca creativa</p><h1 className="mt-2 text-3xl font-semibold">Personajes</h1><p className="mt-2 text-sm text-white/55">Crea una identidad visual y úsala en tus posteos y carruseles.</p></div>
                <button className={`${red} flex items-center gap-2`} onClick={() => { setDraft(blank); setOpen(true); setError(""); }}><Plus size={16} /> Crear personaje</button></div>
            {error && <p role="alert" className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
            {open && <form onSubmit={save} className="mb-9 rounded-3xl border border-white/10 bg-[#0f0f0f] p-5 md:p-7">
                <div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold">{draft.id ? "Editar personaje" : "Nuevo personaje"}</h2><button type="button" className="text-sm text-white/50 hover:text-white" onClick={() => setOpen(false)}>Cerrar</button></div>
                <div className="grid gap-4 md:grid-cols-2"><label className="text-xs text-white/65">Nombre<input required maxLength={80} className={`${input} mt-2`} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
                    <label className="text-xs text-white/65">Sistema de diseño opcional<select className={`${input} mt-2`} value={draft.brandId} onChange={event => setDraft(current => ({ ...current, brandId: event.target.value }))}><option value="">Sin marca vinculada</option>{brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label></div>
                <label className="mt-4 block text-xs text-white/65">Descripción visual<textarea required minLength={10} maxLength={1200} rows={3} className={`${input} mt-2`} placeholder="Edad aparente, cabello, rostro, vestuario y rasgos que deben mantenerse…" value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /></label>
                <label className="mt-4 block text-xs text-white/65">Reglas adicionales<textarea maxLength={1000} rows={2} className={`${input} mt-2`} placeholder="Estilo, accesorios constantes, elementos que no deben cambiar…" value={draft.visualRules} onChange={event => setDraft(current => ({ ...current, visualRules: event.target.value }))} /></label>
                <div className="mt-4 rounded-2xl border border-[#ff4d4d]/25 bg-[#ff4d4d]/[.06] p-3 text-xs leading-5 text-white/65"><strong className="text-white">Identidad por referencias visuales.</strong> Las imágenes guardadas y estas reglas se enviarán con cada generación compatible. No necesitas entrenar ni conectar un identificador externo.</div>
                <div className="mt-6 flex flex-wrap items-center gap-3"><label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-sm text-white hover:bg-white/5"><ImagePlus size={16} /> Subir referencias<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" multiple className="sr-only" disabled={busy} onChange={event => { void addImages(event.target.files); event.target.value = ""; }} /></label>
                    <select aria-label="Modelo para retrato base" className={`${input} max-w-52`} value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Selecciona modelo</option>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select>
                    <button type="button" disabled={busy || !modelId} onClick={() => { void generateBase(); }} className="flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-sm text-white hover:bg-white/5 disabled:opacity-50"><WandSparkles size={16} /> Generar retrato base</button></div>
                {progress && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-white/60"><Loader2 size={13} className="animate-spin" />{progress}</p>}
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{draft.referenceAssetIds.map(id => <div key={id} className={`overflow-hidden rounded-xl border ${id === draft.coverAssetId ? "border-[#ff4d4d]" : "border-white/15"}`}><img src={`/api/workflows/assets/${id}`} alt="Referencia del personaje" className="aspect-square w-full object-cover" /><div className="flex items-center justify-between gap-1 p-2"><button type="button" className="text-xs text-white/70 hover:text-white" onClick={() => setDraft(current => ({ ...current, coverAssetId: id }))}>{id === draft.coverAssetId ? "Portada ✓" : "Usar portada"}</button><button type="button" aria-label="Quitar referencia" onClick={() => setDraft(current => { const ids = current.referenceAssetIds.filter(value => value !== id); return { ...current, referenceAssetIds: ids, coverAssetId: current.coverAssetId === id ? ids[0] || "" : current.coverAssetId }; })}><Trash2 size={14} /></button></div></div>)}</div>
                <div className="mt-6 flex justify-end"><button className={`${red} flex items-center gap-2`} disabled={busy || !draft.referenceAssetIds.length}><Save size={16} /> Guardar personaje</button></div>
            </form>}
            {!characters.length && !open ? <p className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-white/50">Todavía no hay personajes. Crea uno desde una descripción o sube sus fotos.</p> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{characters.map(character => <article key={character.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]"><img src={`/api/workflows/assets/${character.coverAssetId}`} alt={character.name} className="aspect-[4/3] w-full object-cover" /><div className="p-4"><h2 className="font-semibold">{character.name}</h2><p className="mt-1 line-clamp-2 text-xs text-white/55">{character.description}</p><p className="mt-2 text-[11px] text-white/40">{character.referenceAssetIds.length} referencias · versión {character.version}</p><div className="mt-4 flex gap-2"><button className={`${red} flex-1`} onClick={() => { setDraft({ ...character, brandId: character.brandId || "" }); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Editar</button><button disabled={busy} aria-label={`Archivar ${character.name}`} className="rounded-xl border border-white/15 px-3 text-white/65 hover:text-white" onClick={() => { void changeArchive(character, "archive"); }}><Trash2 size={16} /></button></div>
                    <div className="mt-4 border-t border-white/10 pt-3"><p className="text-[11px] text-white/50">Identidad: referencias visuales · compatible con modelos que aceptan imágenes</p></div>
                </div></article>)}</div>}
            {archivedCharacters.length > 0 && <section className="mt-9"><h2 className="mb-3 text-sm font-semibold text-white/60">Archivados</h2><div className="flex flex-wrap gap-2">{archivedCharacters.map(character => <button key={character.id} disabled={busy} type="button" onClick={() => { void changeArchive(character, "restore"); }} className="rounded-xl border border-white/15 px-3 py-2 text-xs text-white hover:border-[#ff4d4d] disabled:opacity-50">Restaurar {character.name}</button>)}</div></section>}
        </div>
    </main>;
}
