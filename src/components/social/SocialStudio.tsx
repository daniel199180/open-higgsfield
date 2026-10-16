"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ArrowLeft, ArrowUpRight, Download, ImagePlus, Palette, Plus, Save, Trash2, VectorSquare } from "lucide-react";
import type { ImageTask } from "@/types";
import type { BrandSystem, SocialFormat, SocialProject } from "@/social/types";
import { brandLogoAssetIds, brandSaveInput, brandTypography, MAX_BRAND_LOGOS, MAX_BRAND_REFERENCES } from "@/social/brand";
import { useImageTasks } from "@/hooks/useImageTasks";
import { BrandReferencesEditor } from "./BrandReferencesEditor";
import { GoogleFontPicker, useGoogleFontPreview } from "./GoogleFontPicker";
import { fontFamilyStyle } from "@/lib/google-fonts";

const LogoLab = dynamic(() => import("./LogoLab").then(module => module.LogoLab), { loading: () => <p className="text-sm text-white/50">Cargando logos…</p> });

/* eslint-disable @next/next/no-img-element -- outputs can come from arbitrary configured image providers. */

type Props = { onBack: () => void };
type BrandDraft = Omit<BrandSystem, "id" | "createdAt" | "updatedAt"> & { id?: string };
type SocialData = { brands: BrandSystem[]; projects: SocialProject[]; storage: string };
const emptySocial: SocialData = { brands: [], projects: [], storage: "" };
async function fetchSocial(url: string): Promise<SocialData> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudieron cargar las marcas y proyectos.");
    return response.json();
}

const blankBrand: BrandDraft = {
    name: "", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#ff4d4d",
    headingFont: "Montserrat", subheadingFont: "Montserrat", bodyFont: "Inter", secondaryBodyFont: "Inter", voice: "Cercana, clara y profesional",
    visualRules: "Diseño limpio, alto contraste y jerarquía visual clara.",
    negativePrompt: "", references: [],
};
const formatLabels: Record<SocialFormat, string> = {
    "post-square": "Post cuadrado", "post-portrait": "Post vertical", story: "Historia", carousel: "Carrusel",
};
const colorFields = [
    { key: "primaryColor", label: "Principal", caption: "Base de la identidad" },
    { key: "secondaryColor", label: "Secundario", caption: "Superficies y contraste" },
    { key: "accentColor", label: "Acento", caption: "Detalles que destacan" },
] as const;
function validColor(value: string, fallback: string) {
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}
const inputClass = "mt-2 w-full rounded-2xl border border-white/10 bg-[#111111] px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-[#ff4d4d]/70 focus:ring-2 focus:ring-[#ff4d4d]/10";
const labelClass = "block text-xs font-medium text-white/65";

async function postSocial(body: unknown) {
    const response = await fetch("/api/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "No se pudo guardar.");
    return value;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function zipFiles(files: Array<{ name: string; bytes: Uint8Array }>) {
    const encoder = new TextEncoder();
    const local: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    let centralLength = 0;
    const crc32 = (bytes: Uint8Array) => {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        return (crc ^ 0xffffffff) >>> 0;
    };
    const header = (length: number, signature: number) => {
        const value = new Uint8Array(length);
        new DataView(value.buffer).setUint32(0, signature, true);
        return value;
    };
    for (const file of files) {
        const name = encoder.encode(file.name);
        const checksum = crc32(file.bytes);
        const localHeader = header(30 + name.length, 0x04034b50);
        const localView = new DataView(localHeader.buffer);
        localView.setUint16(4, 20, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, file.bytes.length, true);
        localView.setUint32(22, file.bytes.length, true);
        localView.setUint16(26, name.length, true);
        localHeader.set(name, 30);
        local.push(localHeader, file.bytes);

        const centralHeader = header(46 + name.length, 0x02014b50);
        const centralView = new DataView(centralHeader.buffer);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, file.bytes.length, true);
        centralView.setUint32(24, file.bytes.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, offset, true);
        centralHeader.set(name, 46);
        central.push(centralHeader);
        centralLength += centralHeader.length;
        offset += localHeader.length + file.bytes.length;
    }
    const end = header(22, 0x06054b50);
    const endView = new DataView(end.buffer);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralLength, true);
    endView.setUint32(16, offset, true);
    const chunks = [...local, ...central, end];
    const archive = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const chunk of chunks) {
        archive.set(chunk, cursor);
        cursor += chunk.length;
    }
    return new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" });
}

function escapeAttribute(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function SocialStudio({ onBack }: Props) {
    const { data: social, error: loadError, mutate: load } = useSWR<SocialData>("/api/social?includeAssets=0", fetchSocial, { revalidateOnFocus: false });
    const data = social ?? emptySocial;
    const [brandDraft, setBrandDraft] = useState<BrandDraft>(blankBrand);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [activeTab, setActiveTab] = useState<"brands" | "projects" | "logos">("brands");
    const [logoBrandId, setLogoBrandId] = useState("");
    const [logoAssetIds, setLogoAssetIds] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const { tasks, mutate: refreshTasks } = useImageTasks(activeTab === "projects");
    const typography = brandTypography(brandDraft);
    useGoogleFontPreview(typography.headingFont);
    useGoogleFontPreview(typography.subheadingFont);
    useGoogleFontPreview(typography.bodyFont);
    useGoogleFontPreview(typography.secondaryBodyFont);

    const project = data.projects.find(item => item.id === selectedProjectId) ?? data.projects[0];
    const projectTasks = (project?.taskIds ?? []).flatMap(id => {
        const task = tasks.find(item => item.task_id === id) as ImageTask | undefined;
        return task ? [task] : [];
    });

    function updateBrand<K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) {
        setBrandDraft(current => ({ ...current, [key]: value }));
    }

    function editBrand(value: BrandSystem) {
        setBrandDraft({ ...value });
        setLogoAssetIds(brandLogoAssetIds(value));
        setLogoBrandId(value.id);
        setActiveTab("brands");
    }

    async function saveBrand(event: React.FormEvent) {
        event.preventDefault();
        setError("");
        setBusy(true);
        try {
            const result = await postSocial({ action: "save-brand", brand: brandSaveInput({ ...brandDraft, logoAssetIds, logoAssetId: logoAssetIds[0] }) });
            await load();
            setBrandDraft({ ...result.brand });
            setLogoBrandId(result.brand.id);
            setActiveTab("brands");
            window.dispatchEvent(new Event("open-higgsfield:social-brands-updated"));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudo guardar la marca.");
        } finally {
            setBusy(false);
        }
    }

    async function uploadLogo(file: File): Promise<string> {
        const response = await fetch("/api/workflows/assets", { method: "POST", headers: { "Content-Type": file.type }, body: file });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "No se pudo subir el logo.");
        return value.asset.id as string;
    }

    async function addLogos(files: File[]) {
        setError("");
        setBusy(true);
        try {
            for (const file of files) {
                const id = await uploadLogo(file);
                setLogoAssetIds(current => [...new Set([...current, id])]);
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudieron subir los logos.");
        } finally {
            setBusy(false);
        }
    }

    async function addReferences(files: File[]) {
        if (files.length + (brandDraft.references?.length ?? 0) > MAX_BRAND_REFERENCES) { setError(`Puedes subir hasta ${MAX_BRAND_REFERENCES} referencias.`); return; }
        setBusy(true); setError("");
        const names = new Set((brandDraft.references ?? []).map(item => item.name));
        try {
            for (const file of files) {
                const assetId = await uploadLogo(file);
                let sequence = 1; while (names.has(`referencia-${sequence}`)) sequence++;
                const name = `referencia-${sequence}`; names.add(name);
                setBrandDraft(current => ({ ...current, references: [...(current.references ?? []), { assetId, name }] }));
            }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo subir la referencia."); }
        finally { setBusy(false); }
    }

    async function exportBrand(value: BrandSystem) {
        try {
            const exported: Record<string, unknown> = { ...value };
            delete exported.logoAssetId;
            delete exported.logoAssetIds;
            delete exported.logoVectorAssetId;
            delete exported.references;
            exported.referenceImages = await Promise.all((value.references ?? []).map(async item => {
                const response = await fetch(`/api/workflows/assets/${item.assetId}`);
                if (!response.ok) throw new Error("No se pudo exportar una referencia.");
                const blob = await response.blob();
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(new Error("No se pudo leer la referencia.")); reader.readAsDataURL(blob);
                });
                return { name: item.name, dataUrl };
            }));
            exported.logoDataUrls = await Promise.all(brandLogoAssetIds(value).map(async id => {
                const response = await fetch(`/api/workflows/assets/${id}`);
                if (!response.ok) throw new Error("No se pudieron incluir todos los logos en el archivo.");
                const blob = await response.blob();
                return new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(new Error("No se pudo leer un logo."));
                    reader.readAsDataURL(blob);
                });
            }));
            downloadBlob(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }), `${value.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "marca"}-design-system.json`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudo exportar el sistema de diseño.");
        }
    }

    async function importBrand(file: File) {
        setError("");
        setBusy(true);
        try {
            if (file.size > 64 * 1024 * 1024) throw new Error("El archivo JSON supera 64 MB.");
            const value = JSON.parse(await file.text()) as Partial<BrandSystem> & { logoDataUrl?: string; logoDataUrls?: string[]; referenceImages?: Array<{ name: string; dataUrl: string }> };
            if (value.referenceImages && (!Array.isArray(value.referenceImages) || value.referenceImages.length > MAX_BRAND_REFERENCES)) throw new Error("Demasiadas referencias en el archivo.");
            const importedReferences: NonNullable<BrandSystem["references"]> = [];
            for (const item of value.referenceImages ?? []) {
                if (!/^[a-z][a-z0-9_-]{0,39}$/.test(item.name) || importedReferences.some(reference => reference.name === item.name)) throw new Error("Nombre de referencia inválido o duplicado.");
                const match = /^data:image\/(png|jpeg|webp|avif);base64,([A-Za-z0-9+/=]+)$/.exec(item.dataUrl);
                if (!match || match[2].length > 28 * 1024 * 1024) throw new Error("Imagen de referencia inválida o demasiado grande.");
                const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
                importedReferences.push({ name: item.name, assetId: await uploadLogo(new File([bytes], "reference.png", { type: `image/${match[1]}` })) });
            }
            if (![value.name, value.primaryColor, value.secondaryColor, value.accentColor, value.headingFont, value.bodyFont].every(item => typeof item === "string")) {
                throw new Error("El JSON no contiene un sistema de diseño válido.");
            }
            setBrandDraft({
                name: value.name!, primaryColor: value.primaryColor!, secondaryColor: value.secondaryColor!, accentColor: value.accentColor!,
                headingFont: value.headingFont!, bodyFont: value.bodyFont!,
                subheadingFont: typeof value.subheadingFont === "string" && value.subheadingFont.trim() ? value.subheadingFont : value.headingFont!,
                secondaryBodyFont: typeof value.secondaryBodyFont === "string" && value.secondaryBodyFont.trim() ? value.secondaryBodyFont : value.bodyFont!,
                voice: typeof value.voice === "string" ? value.voice : "",
                visualRules: typeof value.visualRules === "string" ? value.visualRules : "",
                negativePrompt: typeof value.negativePrompt === "string" ? value.negativePrompt : "", references: importedReferences,
            });
            const logoDataUrls = value.logoDataUrls ?? (value.logoDataUrl ? [value.logoDataUrl] : []);
            if (logoDataUrls.length > MAX_BRAND_LOGOS) throw new Error(`El archivo contiene más de ${MAX_BRAND_LOGOS} logos.`);
            const importedLogoIds: string[] = [];
            for (const logoDataUrl of logoDataUrls) {
                const match = /^data:image\/(png|jpeg|webp|avif);base64,([A-Za-z0-9+/=]+)$/.exec(logoDataUrl);
                if (!match) throw new Error("El logo incluido no tiene un formato compatible.");
                const raw = atob(match[2]);
                if (raw.length > 20 * 1024 * 1024) throw new Error("El logo incluido supera 20 MB.");
                const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
                importedLogoIds.push(await uploadLogo(new File([bytes], `logo.${match[1] === "jpeg" ? "jpg" : match[1]}`, { type: `image/${match[1]}` })));
            }
            setLogoAssetIds(importedLogoIds);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudo importar el archivo.");
        } finally {
            setBusy(false);
        }
    }

    async function deleteBrand(id: string) {
        if (!window.confirm("¿Eliminar este sistema de diseño? Los proyectos vinculados deben conservar su marca.")) return;
        setBusy(true);
        setError("");
        try {
            await postSocial({ action: "delete-brand", id });
            await load();
            window.dispatchEvent(new Event("open-higgsfield:social-brands-updated"));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudo eliminar.");
        } finally {
            setBusy(false);
        }
    }

    async function exportProjectZip() {
        if (!project) return;
        setError("");
        try {
            const files: Array<{ name: string; bytes: Uint8Array }> = [];
            let number = 1;
            for (const task of projectTasks) for (const url of task.result_urls ?? []) {
                const response = await fetch(url);
                if (!response.ok) throw new Error("Una de las imágenes todavía no está disponible para descargar.");
                const mime = response.headers.get("content-type") ?? "image/png";
                const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
                files.push({ name: `pieza-${String(number++).padStart(2, "0")}.${extension}`, bytes: new Uint8Array(await response.arrayBuffer()) });
            }
            if (!files.length) throw new Error("Aún no hay imágenes terminadas para exportar.");
            downloadBlob(zipFiles(files), `${project.name.replace(/[^\p{L}\p{N}-]+/gu, "-")}-imagenes.zip`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "No se pudo preparar el ZIP.");
        }
    }

    function exportProjectPdf() {
        if (!project) return;
        const urls = projectTasks.flatMap(task => task.result_urls ?? []);
        if (!urls.length) {
            setError("Aún no hay imágenes terminadas para exportar.");
            return;
        }
        const safeUrls = urls.map(raw => {
            const url = new URL(raw, window.location.origin);
            if (!(url.protocol === "http:" || url.protocol === "https:")) throw new Error("El proveedor devolvió una URL de imagen inválida.");
            return escapeAttribute(url.href);
        });
        const printWindow = window.open("", "_blank");
        if (!printWindow) {
            setError("Permite abrir una ventana para preparar el PDF.");
            return;
        }
        printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeAttribute(project.name)}</title><style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}.slide{height:273mm;display:grid;place-items:center;page-break-after:always}.slide:last-child{page-break-after:auto}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body>${safeUrls.map((url, index) => `<section class="slide"><img src="${url}" alt="Diapositiva ${index + 1}"></section>`).join("")}<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),500))<\/script></body></html>`);
        printWindow.document.close();
    }

    const previewPrimary = validColor(brandDraft.primaryColor, "#000000");
    const previewSecondary = validColor(brandDraft.secondaryColor, "#ffffff");
    const previewAccent = validColor(brandDraft.accentColor, "#ff4d4d");
    const previewHeadingFont = fontFamilyStyle(typography.headingFont);
    const previewBodyFont = fontFamilyStyle(typography.bodyFont);

    return <main className="h-[100dvh] overflow-x-hidden overflow-y-auto bg-black text-white">
        <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-white/10 bg-black/90 pl-20 pr-4 backdrop-blur-xl sm:pl-24 sm:pr-7">
            <button onClick={onBack} className="rounded-full border border-white/10 p-2 text-white/65 transition hover:border-white/30 hover:text-white" aria-label="Volver"><ArrowLeft size={17} /></button>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#ff4d4d]/10 text-[#ff4d4d]"><Palette size={19} /></div>
            <div><h1 className="text-sm font-semibold sm:text-base">Sistemas de diseño</h1><p className="text-[11px] text-white/45">Tu identidad visual, lista para crear</p></div>
            <span className="ml-auto hidden rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-white/45 sm:inline">{data.storage || "Cargando…"}</span>
        </header>

        <div className="mx-auto max-w-[1440px] px-4 pb-24 pt-6 sm:px-8 sm:pt-9">
            <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-[#101010] px-6 py-8 sm:px-10 sm:py-10">
                <div className="pointer-events-none absolute -right-16 -top-32 h-80 w-80 rounded-full bg-[radial-gradient(circle,#ff4d4d18,transparent_70%)]" />
                <div className="pointer-events-none absolute right-10 top-0 hidden h-full w-px rotate-[28deg] bg-gradient-to-b from-transparent via-[#ff4d4d]/20 to-transparent lg:block" />
                <div className="relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
                    <div className="max-w-2xl">
                        <p className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#ff4d4d]"><span className="h-1.5 w-1.5 rounded-full bg-[#c62828]" /> Estudio de marca</p>
                        <h2 className="text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">Una identidad que se <span className="text-[#ff4d4d]">reconoce.</span></h2>
                        <p className="mt-4 max-w-xl text-sm leading-6 text-white/55 sm:text-base">Define los colores, la voz y las reglas visuales de cada marca. Después podrás aplicarlas al generar contenido desde la página principal.</p>
                    </div>
                    <div className="flex shrink-0 gap-3">
                        <div className="min-w-28 rounded-2xl border border-white/10 bg-white/[.035] px-4 py-3"><span className="block text-2xl font-semibold tracking-tight">{data.brands.length}</span><span className="text-xs text-white/45">Sistemas</span></div>
                        <div className="min-w-28 rounded-2xl border border-white/10 bg-white/[.035] px-4 py-3"><span className="block text-2xl font-semibold tracking-tight">{data.projects.length}</span><span className="text-xs text-white/45">Proyectos</span></div>
                    </div>
                </div>
            </div>

            <nav className="mt-7 flex gap-2 border-b border-white/10 pb-3" aria-label="Sistemas de diseño">
                <button onClick={() => setActiveTab("brands")} aria-current={activeTab === "brands" ? "page" : undefined} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${activeTab === "brands" ? "bg-[#c62828] text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}><Palette size={16} />Sistemas de diseño</button>
                <button onClick={() => setActiveTab("projects")} aria-current={activeTab === "projects" ? "page" : undefined} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${activeTab === "projects" ? "bg-[#c62828] text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}><ImagePlus size={16} />Proyectos</button>
                <button onClick={() => { setLogoBrandId(brandDraft.id ?? data.brands[0]?.id ?? ""); setActiveTab("logos"); }} aria-current={activeTab === "logos" ? "page" : undefined} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${activeTab === "logos" ? "bg-[#c62828] text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}><VectorSquare size={16} />Logos</button>
            </nav>

            <section className="mt-7 min-w-0">
                {(error || loadError) && <div role="alert" className="mb-5 rounded-xl border border-red-400/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">{error || "No se pudieron cargar las marcas y proyectos."}</div>}
                {activeTab === "logos" && <LogoLab brands={data.brands} initialBrandId={logoBrandId} onBrandUpdated={async brand => { await load(); setBrandDraft(current => current.id === brand.id ? { ...brand } : current); if (brandDraft.id === brand.id) setLogoAssetIds(brandLogoAssetIds(brand)); }} />}

                {activeTab === "brands" && <div className="space-y-9">
                    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#ff4d4d]">Editor de identidad</p><h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Diseña cómo se ve tu marca.</h2><p className="mt-2 text-sm text-white/45">Los cambios se reflejan al instante en la vista previa.</p></div><button type="button" onClick={() => { setBrandDraft({ ...blankBrand }); setLogoAssetIds([]); document.getElementById("brand-editor")?.scrollIntoView({ behavior: "smooth" }); }} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/80 transition hover:border-[#ff4d4d]/50 hover:text-[#ff4d4d]"><Plus size={16} />Nuevo sistema</button></div>

                    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                        <div className="lg:sticky lg:top-24">
                            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[#101010] p-3 sm:p-4">
                                <div className="mb-4 flex items-center justify-between px-2 pt-1"><span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55"><span className="h-1.5 w-1.5 rounded-full bg-[#c62828]" />Vista previa en vivo</span><span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-white/45">Concepto visual</span></div>
                                <div className="relative flex min-h-[360px] flex-col justify-between overflow-hidden rounded-[22px] p-7 sm:min-h-[430px] sm:p-9" style={{ background: `linear-gradient(145deg, ${previewPrimary} 0%, #090909 80%)` }}>
                                    <div className="pointer-events-none absolute -right-20 top-1/4 h-64 w-64 rounded-full border-[42px] opacity-30" style={{ borderColor: previewAccent }} />
                                    <div className="pointer-events-none absolute right-0 top-1/3 h-64 w-64 rounded-full" style={{ background: "radial-gradient(circle, " + previewAccent + "40, transparent 70%)" }} />
                                    <div className="relative flex items-start justify-between gap-4"><div className="flex items-center gap-3">{logoAssetIds[0] ? <img decoding="async" loading="lazy" src={`/api/workflows/assets/${logoAssetIds[0]}`} alt="Logo de referencia" className="h-10 w-10 rounded-xl bg-neutral-500 object-contain p-1" /> : <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/25 bg-white/10 text-sm font-semibold" style={{ color: previewSecondary }}>{(brandDraft.name || "M").trim().slice(0, 1).toUpperCase()}</span>}<span className="max-w-[180px] truncate text-sm font-semibold tracking-wide" style={{ color: previewSecondary }}>{brandDraft.name || "Tu marca"}</span></div><ArrowUpRight size={20} style={{ color: previewAccent }} /></div>
                                    <div className="relative max-w-[370px]"><span className="mb-4 inline-flex rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ borderColor: previewAccent, color: previewAccent }}><span style={{ fontFamily: fontFamilyStyle(typography.subheadingFont) }}>Identidad en movimiento</span></span><p className="text-4xl font-semibold leading-[1.06] tracking-[-0.05em] sm:text-5xl" style={{ color: previewSecondary, fontFamily: previewHeadingFont }}>Ideas que se<br /><span style={{ color: previewAccent }}>sienten</span> como marca.</p><p className="mt-5 line-clamp-3 max-w-xs text-xs leading-5 text-white/70" style={{ fontFamily: previewBodyFont }}>{brandDraft.voice || "Una voz única para cada idea."}</p><span className="mt-7 inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold" style={{ backgroundColor: previewAccent, color: previewPrimary }}>Explorar ideas <ArrowUpRight size={13} /></span></div>
                                    <div className="relative flex items-center justify-between border-t border-white/20 pt-4 text-[10px] uppercase tracking-[0.14em] text-white/65"><span style={{ fontFamily: fontFamilyStyle(typography.secondaryBodyFont) }}>Texto de apoyo · Tu marca</span><span>01 / 04</span></div>
                                </div>
                                <div className="grid grid-cols-3 gap-2 px-1 pt-4">{colorFields.map(({ key, label }) => <div key={key} className="min-w-0"><div className="h-8 rounded-lg border border-white/10" style={{ backgroundColor: validColor(brandDraft[key], "#555555") }} /><p className="mt-2 truncate text-[10px] text-white/45">{label} · {brandDraft[key]}</p></div>)}</div>
                                <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 px-1 pt-4">{[["Título", typography.headingFont], ["Subtítulo", typography.subheadingFont], ["Texto 1", typography.bodyFont], ["Texto 2", typography.secondaryBodyFont]].map(([role, family]) => <span key={role} className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-white/60">{role} · {family}</span>)}</div>
                            </div>
                            <p className="mt-3 px-2 text-xs leading-5 text-white/35">Esta muestra representa la dirección visual de la marca; las imágenes finales las genera el modelo elegido.</p>
                        </div>

                        <form id="brand-editor" onSubmit={saveBrand} className="overflow-hidden rounded-[28px] border border-white/10 bg-[#0d0d0d]">
                            <div className="border-b border-white/10 px-5 py-6 sm:px-7"><div className="flex items-start justify-between gap-4"><div><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.17em] text-[#ff4d4d]">{brandDraft.id ? "Sistema existente" : "Nuevo sistema"}</p><h3 className="text-xl font-semibold tracking-tight">{brandDraft.id ? "Edita tu identidad" : "Construye tu identidad"}</h3><p className="mt-1 text-sm text-white/45">Cada detalle ayuda a mantener la coherencia en tus creaciones.</p></div><Palette className="mt-1 shrink-0 text-[#ff4d4d]" size={21} /></div></div>
                            <div className="space-y-7 p-5 sm:p-7">
                                <div>
                                    <div className="mb-4 flex items-center gap-3"><span className="text-xs font-semibold text-[#ff4d4d]">01</span><h4 className="text-sm font-semibold">Logos de referencia</h4><span className="h-px flex-1 bg-white/10" /></div>
                                    <label className={`${labelClass} block rounded-2xl border border-dashed border-white/15 bg-white/[.02] p-4 transition hover:border-[#ff4d4d]/40`}>
                                        <span className="flex items-center gap-2 text-sm text-white/75"><ImagePlus size={17} />Añadir logos ({logoAssetIds.length}/{MAX_BRAND_LOGOS})</span>
                                        <span className="mt-1 block text-xs font-normal text-white/40">PNG, JPG, WebP o AVIF. Se conserva la transparencia del PNG; el gris es solo para visualizarlo. Todos se envían como referencias al generar un posteo. Si el modelo no admite imágenes, se te avisará antes de generar.</span>
                                        <input className="mt-3 block w-full text-xs text-white/50 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-xs file:text-white" type="file" accept="image/png,image/jpeg,image/webp,image/avif" multiple disabled={busy || logoAssetIds.length >= MAX_BRAND_LOGOS} onChange={event => {
                                            const files = Array.from(event.target.files ?? []);
                                            event.target.value = "";
                                            if (files.length + logoAssetIds.length > MAX_BRAND_LOGOS) { setError(`Puedes subir hasta ${MAX_BRAND_LOGOS} logos.`); return; }
                                            void addLogos(files);
                                        }} />
                                    </label>
                                    {logoAssetIds.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{logoAssetIds.map((id, index) => <div key={id} className="flex items-center gap-3 rounded-xl bg-white/5 p-3"><img decoding="async" loading="lazy" src={`/api/workflows/assets/${id}`} alt={`Logo de referencia ${index + 1}`} className="h-12 w-12 rounded-lg bg-neutral-500 object-contain p-1" /><span className="min-w-0 flex-1 text-xs text-white/55">Logo {index + 1}</span><button type="button" className="text-xs text-white/50 hover:text-white" onClick={() => { setLogoAssetIds(current => current.filter(value => value !== id)); setBrandDraft(current => ({ ...current, logoVectorAssetId: undefined })); }}>Quitar</button></div>)}</div>}
                                </div>
                                <BrandReferencesEditor references={brandDraft.references ?? []} disabled={busy} onChange={value => updateBrand("references", value)} onUpload={files => void addReferences(files)} onMention={name => {
                                    const input = document.getElementById("brand-visual-rules") as HTMLTextAreaElement | null;
                                    const current = brandDraft.visualRules; const at = input?.selectionStart ?? current.length;
                                    const next = current.slice(0, at) + ` @${name} ` + current.slice(input?.selectionEnd ?? at);
                                    if (next.length > 1000) { setError("Las reglas visuales admiten hasta 1000 caracteres."); return; }
                                    updateBrand("visualRules", next); input?.focus();
                                }} />

                                <div><div className="mb-4 flex items-center gap-3"><span className="text-xs font-semibold text-[#ff4d4d]">03</span><h4 className="text-sm font-semibold">Esencia de marca</h4><span className="h-px flex-1 bg-white/10" /></div><label className={labelClass}>Nombre de marca<input className={inputClass} required maxLength={80} value={brandDraft.name} onChange={event => updateBrand("name", event.target.value)} placeholder="Ej. Mi marca" /></label></div>
                                <div><div className="mb-4 flex items-center gap-3"><span className="text-xs font-semibold text-[#ff4d4d]">04</span><h4 className="text-sm font-semibold">Paleta de color</h4><span className="h-px flex-1 bg-white/10" /></div><div className="grid gap-3 sm:grid-cols-3">{colorFields.map(({ key, label, caption }) => <div key={key} className="rounded-2xl border border-white/10 bg-white/[.025] p-3"><label className="block text-xs font-medium text-white/80" htmlFor={`${key}-picker`}>{label}<small className="mt-0.5 block text-[10px] font-normal text-white/40">{caption}</small></label><div className="mt-3 flex items-center gap-2"><input id={`${key}-picker`} aria-label={`Color ${label.toLowerCase()}`} type="color" className="h-10 w-10 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent p-0.5" value={validColor(brandDraft[key], "#000000")} onChange={event => updateBrand(key, event.target.value)} /><input aria-label={`Código del color ${label.toLowerCase()}`} className="min-w-0 w-full rounded-lg border border-white/10 bg-[#111111] px-2 py-2 text-xs text-white outline-none focus:border-[#ff4d4d]/60" value={brandDraft[key]} onChange={event => updateBrand(key, event.target.value)} /></div></div>)}</div></div>
                                <div><div className="mb-4 flex items-center gap-3"><span className="text-xs font-semibold text-[#ff4d4d]">05</span><h4 className="text-sm font-semibold">Tipografías, voz y reglas</h4><span className="h-px flex-1 bg-white/10" /></div><div className="grid gap-4 sm:grid-cols-2"><GoogleFontPicker label="Título principal" value={typography.headingFont} onChange={value => updateBrand("headingFont", value)} /><GoogleFontPicker label="Título secundario" value={typography.subheadingFont} onChange={value => updateBrand("subheadingFont", value)} /><GoogleFontPicker label="Texto 1 · Cuerpo principal" value={typography.bodyFont} onChange={value => updateBrand("bodyFont", value)} /><GoogleFontPicker label="Texto 2 · Apoyos y notas" value={typography.secondaryBodyFont} onChange={value => updateBrand("secondaryBodyFont", value)} /><p className="text-xs leading-5 text-white/40 sm:col-span-2">Busca familias de Google Fonts. La vista previa usa las fuentes seleccionadas; la IA recibe estos roles como instrucciones y puede aproximar la tipografía al generar.</p><label className={`${labelClass} sm:col-span-2`}>Voz de marca<textarea className={`${inputClass} min-h-24 resize-y`} maxLength={500} value={brandDraft.voice} onChange={event => updateBrand("voice", event.target.value)} placeholder="¿Cómo habla tu marca?" /></label><label className={`${labelClass} sm:col-span-2`}>Reglas visuales<textarea id="brand-visual-rules" className={`${inputClass} min-h-28 resize-y`} maxLength={1000} value={brandDraft.visualRules} onChange={event => updateBrand("visualRules", event.target.value)} placeholder="Composición, estilo, elementos que deben mantenerse…" /></label></div></div>
                                <label className={labelClass}>Prompt negativo / Prohibiciones<textarea className={`${inputClass} min-h-28 resize-y`} rows={4} maxLength={2000} value={brandDraft.negativePrompt ?? ""} onChange={event => updateBrand("negativePrompt", event.target.value)} placeholder="Ej. No cambiar el logo. No usar degradados. No incluir precios inventados." /><span className="mt-2 block text-xs font-normal text-white/40">Se envían como instrucciones en cada generación. Son indicaciones para la IA, no una garantía automática.</span></label>

                            </div>
                            <div className="flex flex-wrap gap-2 border-t border-white/10 bg-white/[.02] p-5 sm:p-7"><button disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-[#c62828] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#ad1f1f] disabled:opacity-50"><Save size={16} />{busy ? "Guardando…" : brandDraft.id ? "Guardar cambios" : "Guardar sistema"}</button><button type="button" onClick={() => { setBrandDraft({ ...blankBrand }); setLogoAssetIds([]); }} className="rounded-xl border border-white/10 px-4 py-3 text-sm text-white/65 transition hover:border-white/25 hover:text-white">Limpiar</button><label className="cursor-pointer rounded-xl border border-white/10 px-4 py-3 text-sm text-white/65 transition hover:border-white/25 hover:text-white">Importar JSON<input className="sr-only" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importBrand(file); event.target.value = ""; }} /></label></div>
                        </form>
                    </div>

                    <div className="border-t border-white/10 pt-8"><div className="mb-5 flex items-end justify-between gap-3"><div><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#ff4d4d]">Tu biblioteca</p><h3 className="text-2xl font-semibold tracking-tight">Sistemas guardados <span className="text-white/35">({data.brands.length})</span></h3></div><p className="hidden text-xs text-white/40 sm:block">Elige uno para editarlo</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{data.brands.map(item => <div key={item.id} className="group overflow-hidden rounded-[24px] border border-white/10 bg-[#0d0d0d] transition hover:border-[#ff4d4d]/35"><button type="button" onClick={() => { editBrand(item); document.getElementById("brand-editor")?.scrollIntoView({ behavior: "smooth" }); }} className="block w-full text-left"><div className="relative flex h-40 flex-col justify-between overflow-hidden p-5" style={{ background: `linear-gradient(135deg, ${validColor(item.primaryColor, "#000000")}, #090909)` }}><div className="absolute -right-8 top-1/2 h-32 w-32 rounded-full border-[22px] opacity-35" style={{ borderColor: validColor(item.accentColor, "#ff4d4d") }} /><div className="relative flex items-center justify-between"><span className="grid h-9 w-9 place-items-center rounded-lg border border-white/25 bg-black/20 text-xs font-semibold" style={{ color: validColor(item.secondaryColor, "#ffffff") }}>{item.name.slice(0, 1).toUpperCase()}</span><ArrowUpRight size={17} className="text-white/65 transition group-hover:text-white" /></div><div className="relative"><span className="block truncate text-xl font-semibold tracking-tight" style={{ color: validColor(item.secondaryColor, "#ffffff") }}>{item.name}</span><span className="mt-1 block truncate text-xs text-white/70">{item.voice || "Identidad de marca"}</span></div></div></button><div className="flex items-center gap-2 px-5 py-4"><div className="flex gap-1.5">{colorFields.map(({ key }) => <span key={key} className="h-4 w-4 rounded-full border border-white/15" style={{ backgroundColor: validColor(item[key], "#555555") }} />)}</div><span className="min-w-0 flex-1 truncate pl-2 text-[11px] text-white/45">{item.headingFont} · {item.bodyFont}</span><button type="button" onClick={() => void exportBrand(item)} className="rounded-lg p-2 text-white/40 transition hover:bg-white/5 hover:text-white" aria-label={`Exportar ${item.name} como JSON`}><Download size={15} /></button><button type="button" disabled={busy} onClick={() => void deleteBrand(item.id)} className="rounded-lg p-2 text-white/40 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50" aria-label={`Eliminar ${item.name}`}><Trash2 size={15} /></button></div></div>)}{!data.brands.length && <div className="col-span-full flex min-h-44 flex-col items-center justify-center rounded-[24px] border border-dashed border-white/15 bg-white/[.02] p-6 text-center"><Palette className="mb-3 text-[#ff4d4d]" size={24} /><p className="text-sm font-medium">Tu biblioteca comienza aquí</p><p className="mt-1 text-xs text-white/45">Guarda tu primer sistema para usarlo en futuras creaciones.</p></div>}</div></div>
                </div>}

                {activeTab === "projects" && <div className="space-y-5">
                    <div className="rounded-2xl border border-white/10 bg-[#0d0d0d] p-5 sm:p-6">
                        <h2 className="text-lg font-semibold">Proyectos sociales</h2>
                        <p className="mb-5 mt-1 text-sm text-white/45">Consulta proyectos guardados anteriormente y descarga sus resultados.</p>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {data.projects.map(item => <button key={item.id} onClick={() => setSelectedProjectId(item.id)} className={`rounded-xl border p-4 text-left hover:border-[#ff4d4d]/30 ${selectedProjectId === item.id ? "border-[#ff4d4d]/35" : "border-white/10"}`}><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs text-white/45">{formatLabels[item.format]} · {item.taskIds.length}/{item.slideCount} piezas</span><span className="mt-2 block text-[10px] text-white/35">{new Date(item.updatedAt).toLocaleString()}</span></button>)}
                            {!data.projects.length && <p className="rounded-xl border border-dashed border-white/10 p-5 text-sm text-white/45">No hay proyectos anteriores guardados. Para crear contenido nuevo, vuelve a la página principal y selecciona un sistema de diseño.</p>}
                        </div>
                    </div>

                    {project && <div className="rounded-2xl border border-white/10 bg-[#0d0d0d] p-5 sm:p-6">
                        <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold">{project.name}</h3><p className="mt-1 text-xs text-white/45">{formatLabels[project.format]} · {project.status === "completed" ? "Completado" : project.status}</p></div><div className="flex flex-wrap gap-2">{project.format === "carousel" && (project.slides ? <><a href={`?mode=carousel&carousel=${project.id}`} className="inline-flex items-center gap-1 rounded-lg border border-[#ff4d4d]/30 px-3 py-2 text-xs text-[#ff4d4d]">Abrir carrusel</a><a href={`/api/social/carousels/${project.id}/export?format=zip`} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:text-white"><Download size={13} />ZIP</a><a href={`/api/social/carousels/${project.id}/export?format=pdf`} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:text-white"><Download size={13} />PDF</a></> : <><button type="button" onClick={() => void exportProjectZip()} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:text-white"><Download size={13} />ZIP</button><button type="button" onClick={exportProjectPdf} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:text-white">Imprimir PDF</button></>)}</div></div>
                        {project.brief && <p className="mb-4 rounded-xl bg-white/[.03] p-3 text-sm text-white/55">{project.brief}</p>}
                        {projectTasks.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{projectTasks.flatMap(task => (task.result_urls ?? []).map((url, index) => <a key={`${task.task_id}-${index}`} href={url} download target="_blank" rel="noreferrer" className="group relative block overflow-hidden rounded-xl border border-white/10 bg-black"><img decoding="async" loading="lazy" src={url} alt={`Resultado ${index + 1}`} className="aspect-[4/5] w-full object-cover" /><span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/65 py-2 text-[10px] opacity-0 transition group-hover:opacity-100"><Download size={12} />Descargar</span></a>))}</div> : <p className="rounded-xl border border-dashed border-white/10 p-5 text-sm text-white/45">Este proyecto todavía no tiene imágenes disponibles.</p>}
                        {projectTasks.some(task => !task._done) && <p className="mt-3 text-xs text-white/50">El proveedor sigue generando algunas imágenes.</p>}
                        {projectTasks.some(task => task.error_message) && <p className="mt-2 text-xs text-red-200">{projectTasks.find(task => task.error_message)?.error_message}</p>}
                        <button type="button" onClick={() => void refreshTasks()} className="mt-4 w-full rounded-xl border border-white/10 py-2 text-xs text-white/60 hover:text-white">Actualizar resultados</button>
                    </div>}
                </div>}
            </section>
        </div>
    </main>;
}
