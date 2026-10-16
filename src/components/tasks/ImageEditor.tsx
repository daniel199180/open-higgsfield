"use client";

/* eslint-disable @next/next/no-img-element -- authenticated local image and user upload previews */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Download, Eraser, Expand, Eye, EyeOff, GripVertical, Hand, ImagePlus, Layers, Loader2, MessageCircle, Paintbrush, RotateCcw, Scissors, Sparkles, Trash2, Type, X, ZoomIn, ZoomOut } from "lucide-react";
import { useImageTasks, revalidateImageTasks } from "@/hooks/useImageTasks";
import { OUTPAINT_RATIOS, planOutpaint, type OutpaintSide, type OutpaintRatio } from "@/lib/image-outpaint";
import type { ImageLayerMetadata, ImageLayerSet } from "@/types";
import { isLayerTask } from "@/lib/image-layer-task";
import { useEditorDocument } from "@/hooks/useEditorDocument";
import { blankEditorSnapshot, editorSnapshotSchema, textLayerSchema, type EditorSnapshot, type EditorStroke } from "@/lib/editor-document";
import { editorImageUrl, ensureEditorFont, renderEditorSnapshot, type TextBounds } from "@/lib/editor-renderer";
import { hasReliableLayerLayout, layerFrame } from "@/lib/image-layer-layout";

interface Props { imageUrl?: string; taskId?: string; index?: number; prompt?: string; documentId?: string; onClose: () => void; embedded?: boolean; onRequestImage?: () => void; onOpenDocument?: (id: string) => void; onNewFromOriginal?: () => void; registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void }
type Tool = "prompt" | "mask" | "erase" | "comments" | "background" | "expand" | "layers" | "text";
type EditModel = { id: string; label: string; provider?: string; providerModelId?: string; connectionId?: string; aspectRatios?: string[]; supportsExpand?: boolean; supportsMask?: boolean };
type Version = { id: string; url: string; label: string; prompt: string; index: number; parentId?: string };
type LayerTransform = { x: number; y: number; scale: number };
type TextLayer = { id: string; text: string; x: number; y: number; fontFamily: string; fontSize: number; fontWeight: number; color: string; align: "left" | "center" | "right"; visible: boolean };
type DragGesture = { pointerId: number; target: HTMLElement; captureTarget: HTMLElement; startX: number; startY: number; initialX: number; initialY: number; x: number; y: number; rectWidth: number; rectHeight: number; displayWidth: number; displayHeight: number; frame: number | null; baseTransform: string };

const EDIT_TOOLS = [
    { id: "prompt", label: "Imagen completa", icon: Sparkles },
    { id: "mask", label: "Pintar zona", icon: Paintbrush },
    { id: "erase", label: "Borrar partes", icon: Eraser },
    { id: "comments", label: "Comentarios", icon: MessageCircle },
    { id: "background", label: "Quitar fondo", icon: Scissors },
    { id: "expand", label: "Expandir bordes", icon: Expand },
    { id: "layers", label: "Capas", icon: Layers },
    { id: "text", label: "Texto", icon: Type },
] as const;

const GOOGLE_FONT_FAMILIES = [
    "Manrope", "Space Grotesk", "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Raleway", "Oswald", "Merriweather", "Playfair Display", "Source Sans 3", "DM Sans", "Work Sans", "Rubik", "Outfit", "Plus Jakarta Sans", "Figtree", "Bebas Neue", "Anton", "Archivo", "Barlow", "Bitter", "Cabin", "Caveat", "Cormorant Garamond", "Crimson Text", "Dancing Script", "EB Garamond", "Exo 2", "Fira Sans", "Fjalla One", "Heebo", "Josefin Sans", "Karla", "Libre Baskerville", "Libre Franklin", "Lora", "Maven Pro", "Merriweather Sans", "Mulish", "Noto Sans", "Noto Serif", "Pacifico", "Permanent Marker", "Quicksand", "Satisfy", "Signika", "Slabo 27px", "Spectral", "Teko", "Titillium Web", "Ubuntu", "Varela Round", "Vollkorn", "Yanone Kaffeesatz", "Yeseva One", "Zilla Slab",
];

const MIN_ZOOM = 50;
const MAX_ZOOM = 250;
const ZOOM_STEP = 25;

function paintAt(canvas: HTMLCanvasElement, x: number, y: number, radius: number, erase: boolean) {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = erase ? "destination-out" : "source-over";
    context.fillStyle = erase ? "#000" : "rgba(239,68,68,.5)";
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
}

export function ImageEditor({ imageUrl = "", taskId, index = 0, prompt, documentId, onClose, embedded = false, onRequestImage, onOpenDocument, onNewFromOriginal, registerBeforeLeave }: Props) {
    const [documentSource, setDocumentSource] = useState({ taskId: taskId ?? "", index });
    const doc = useEditorDocument(documentSource.taskId, documentSource.index, documentId, prompt || "Edición de imagen");
    const state = doc.snapshot;
    function fieldSetter<K extends keyof EditorSnapshot>(key: K, label: string) {
        return (value: React.SetStateAction<EditorSnapshot[K]>) => doc.update(previous => ({ ...previous, [key]: typeof value === "function" ? (value as (prev: EditorSnapshot[K]) => EditorSnapshot[K])(previous[key]) : value }), label);
    }
    const currentTaskId = state.taskId; const currentIndex = state.index;
    const currentUrl = currentTaskId ? editorImageUrl(currentTaskId, currentIndex) : "";
    const [reference, setReference] = useState<File | null>(null);
    const [referenceUrl, setReferenceUrl] = useState("");
    const [tool, setTool] = useState<Tool>("prompt");
    const comments = state.comments; const setComments = fieldSetter("comments", "Comentarios");
    const [selectedComment, setSelectedComment] = useState("");
    const instruction = state.instructions[tool];
    const setInstruction = (value: string) => doc.update(previous => ({ ...previous, instructions: { ...previous.instructions, [tool]: value } }), "Instrucciones");
    const [model, setModel] = useState("");
    const [quality, setQuality] = useState("high");
    const [aspectRatio, setAspectRatio] = useState("auto");
    const outpaintPadding = state.padding; const setOutpaintPadding = fieldSetter("padding", "Expandir bordes");
    const [preserveOriginal, setPreserveOriginal] = useState(true);
    const [brush, setBrush] = useState(5);
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [models, setModels] = useState<EditModel[]>([]);
    const [connectionMessage, setConnectionMessage] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [backgroundModels, setBackgroundModels] = useState<Array<{ id: string; name: string }>>([]);
    const [backgroundModel, setBackgroundModel] = useState("");
    const [backgroundMessage, setBackgroundMessage] = useState("");
    const [outpaintPrice, setOutpaintPrice] = useState("Consultar precio");
    const [painted, setPainted] = useState(false);
    const layerTaskId = state.layerTaskId; const setLayerTaskId = fieldSetter("layerTaskId", "Capas");
    const [layerPrompt, setLayerPrompt] = useState("");
    const [recoveringLayers, setRecoveringLayers] = useState(false);
    const [layerSize, setLayerSize] = useState("auto");
    const [selectedLayerIndex, setSelectedLayerIndex] = useState(1);
    const [layerEditPrompt, setLayerEditPrompt] = useState("");
    const layerVisibility = state.layerVisibility; const setLayerVisibility = fieldSetter("layerVisibility", "Visibilidad de capas");
    const deletedLayerIndexes = state.deletedLayerIndexes; const setDeletedLayerIndexes = fieldSetter("deletedLayerIndexes", "Eliminar capa");
    const layerOrder = state.layerOrder; const setLayerOrder = fieldSetter("layerOrder", "Orden de capas");
    const layerTransforms = state.layerTransforms; const setLayerTransforms = fieldSetter("layerTransforms", "Mover capa");
    const textLayers = state.textLayers; const setTextLayers = fieldSetter("textLayers", "Editar texto");
    const [selectedTextLayerId, setSelectedTextLayerId] = useState("");
    const [googleFontFamilies, setGoogleFontFamilies] = useState(GOOGLE_FONT_FAMILIES);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(100);
    const [panMode, setPanMode] = useState(true);
    const [draggingCanvas, setDraggingCanvas] = useState(false);
    const viewportRef = useRef<HTMLDivElement>(null);
    const layerViewportRef = useRef<HTMLDivElement>(null);
    const panGesture = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean } | null>(null);
    const suppressCanvasClick = useRef(false);
    const zoomRef = useRef(100);
    const pendingZoomAnchor = useRef<{ x: number; y: number; ratio: number } | null>(null);
    const drawing = useRef(false);
    const lastPoint = useRef<{ x: number; y: number } | null>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef<HTMLCanvasElement | null>(null);
    const activeCardRef = useRef<HTMLElement>(null);
    const sourceImageRef = useRef<HTMLImageElement>(null);
    const layerCanvasRef = useRef<HTMLDivElement>(null);
    const layerDrag = useRef<(DragGesture & { index: number; scale: number }) | null>(null);
    const textDrag = useRef<(DragGesture & { id: string }) | null>(null);
    const borderDrag = useRef<{ pointerId: number; side: OutpaintSide; startX: number; startY: number; initial: number; displayWidth: number; displayHeight: number } | null>(null);
    const inFlight = useRef(false);
    const migratedLegacy = useRef(false);
    const strokeGesture = useRef<EditorStroke | null>(null);
    const [composition, setComposition] = useState<{ url: string; key: string; bounds: TextBounds[] } | null>(null);
    const [renderError, setRenderError] = useState("");
    const [showHistory, setShowHistory] = useState(false);
    useEffect(() => {
        registerBeforeLeave?.(() => inFlight.current ? Promise.resolve(false) : doc.save());
        return () => registerBeforeLeave?.(null);
    }, [registerBeforeLeave, doc]);
    useEffect(() => {
        if (!busy) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
    }, [busy]);
    const { tasks } = useImageTasks();
    const currentTask = tasks.find((item) => item.task_id === currentTaskId && item.status === "COMPLETED");
    const rootId = typeof currentTask?.reuse_state?.edit_root_task_id === "string" ? currentTask.reuse_state.edit_root_task_id : documentSource.taskId;
    const rootIndex = typeof currentTask?.reuse_state?.edit_root_index === "number" ? currentTask.reuse_state.edit_root_index : documentSource.index;
    const linkedLayerTask = tasks
        .filter((item) => isLayerTask(item) && item.reuse_state?.layer_source_task_id === currentTaskId && item.reuse_state?.layer_source_index === currentIndex && item.status === "COMPLETED")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const layerTask = tasks.find((item) => item.task_id === layerTaskId && item.status === "COMPLETED");
    const layerSet = layerTask?.reuse_state?.layer_set as ImageLayerSet | undefined;
    const reliableLayerSet = !!layerSet && hasReliableLayerLayout(layerSet);
    const [layerRecoveries, setLayerRecoveries] = useState<Array<{ id: string; createdAt: string }>>([]);
    const recoverySourceId = layerTask && !reliableLayerSet ? layerTask.task_id : currentTaskId;
    const recoverySourceIndex = layerTask && !reliableLayerSet ? layerSet?.referenceIndex ?? 0 : currentIndex;
    useEffect(() => {
        let active = true;
        if (!recoverySourceId || busy || tool !== "layers") return;
        fetch(`/api/images/layers?sourceTaskId=${encodeURIComponent(recoverySourceId)}&index=${recoverySourceIndex}`, { cache: "no-store" })
            .then(async response => response.ok ? response.json() : { jobs: [] })
            .then(data => { if (active) setLayerRecoveries(data.jobs ?? []); })
            .catch(() => { if (active) setLayerRecoveries([]); });
        return () => { active = false; };
    }, [recoverySourceId, recoverySourceIndex, busy, tool]);
    const layerImages = layerTask ? (layerTask.result_urls?.length ? layerTask.result_urls : (layerTask.result_paths ?? []).map((_, item) => `/api/download/${encodeURIComponent(layerTask.task_id)}?index=${item}`)) : [];
    const canvasWidth = Math.max(1, layerSet?.canvasWidth ?? layerSet?.sourceWidth ?? 1);
    const canvasHeight = Math.max(1, layerSet?.canvasHeight ?? layerSet?.sourceHeight ?? 1);
    const referenceIndex = layerSet?.referenceIndex ?? (layerSet && layerSet.version >= 2 ? 0 : undefined);
    const isLockedLayer = (index: number) => index === layerSet?.baseIndex || index === referenceIndex;
    const selectedLayerEditable = !!layerSet && selectedLayerIndex > 0 && !isLockedLayer(selectedLayerIndex);
    function activeViewport() {
        return (tool === "layers" || tool === "text") && layerTask && reliableLayerSet ? layerViewportRef.current : viewportRef.current;
    }
    const selectedTextLayer = textLayers.find((item) => item.id === selectedTextLayerId);
    const orderedLayers = (layerSet?.layers ?? []).filter((layer) => !deletedLayerIndexes[layer.index]).slice().sort((a, b) => {
        const ai = layerOrder.indexOf(a.index); const bi = layerOrder.indexOf(b.index);
        if (ai < 0 && bi < 0) return a.zIndex - b.zIndex;
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
    });

    useEffect(() => {
        let active = true;
        fetch("/api/images/edit", { cache: "no-store" })
            .then((response) => response.json())
            .then((data: { configured?: boolean; models?: EditModel[]; defaultModelId?: string; message?: string }) => {
                if (!active) return;
                setConfigured(!!data.configured); setConnectionMessage(data.message ?? "");
                const available = data.models ?? [];
                setModels(available);
                if (available.length) setModel(data.defaultModelId && available.some((item) => item.id === data.defaultModelId) ? data.defaultModelId : available[0].id);
            })
            .catch(() => { if (active) setConfigured(false); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        let active = true;
        fetch("/api/images/remove-background", { cache: "no-store" })
            .then((response) => response.json())
            .then((data: { models?: Array<{ id: string; name: string }>; defaultModelId?: string; message?: string }) => {
                if (!active) return;
                setBackgroundModels(data.models ?? []); setBackgroundModel(data.defaultModelId ?? ""); setBackgroundMessage(data.message ?? "");
            })
            .catch(() => { if (active) setBackgroundMessage("No se pudieron consultar los modelos para quitar fondo."); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        // The object URL is an external resource with an explicit disposal lifecycle.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!reference) { setReferenceUrl(""); return; }
        const url = URL.createObjectURL(reference); setReferenceUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [reference]);
    // Import legacy browser edits once. Polling tasks and changing selection must never reset a document.
    useEffect(() => {
        if (!doc.ready || !currentTask || migratedLegacy.current) return;
        migratedLegacy.current = true;
        if (doc.history.entries.length !== 1 || state.layerTaskId || state.textLayers.length) return;
        const patch: Partial<EditorSnapshot> = {};
        try {
            const rows = JSON.parse(localStorage.getItem(`open-higgsfield:text-layers:${currentTaskId}:${currentIndex}`) || "[]");
            if (Array.isArray(rows)) patch.textLayers = rows.flatMap(row => { const value = textLayerSchema.safeParse(row); return value.success ? [value.data] : []; });
            const legacy = isLayerTask(currentTask) ? currentTask : linkedLayerTask;
            const set = legacy?.reuse_state?.layer_set as ImageLayerSet | undefined;
            if (legacy && set) {
                patch.layerTaskId = legacy.task_id;
                patch.layerOrder = JSON.parse(localStorage.getItem(`open-higgsfield:layer-order:${legacy.task_id}`) || "null") || set.layers.slice().sort((a, b) => a.zIndex - b.zIndex).map(layer => layer.index);
                patch.layerTransforms = JSON.parse(localStorage.getItem(`open-higgsfield:layer-transforms:${legacy.task_id}`) || "{}");
                patch.deletedLayerIndexes = JSON.parse(localStorage.getItem(`open-higgsfield:layer-deleted:${legacy.task_id}`) || "{}");
                patch.layerVisibility = set.referenceIndex === undefined ? {} : { [set.referenceIndex]: false };
            }
            if ((patch.layerTaskId || patch.textLayers?.length) && editorSnapshotSchema.safeParse({ ...state, ...patch }).success) doc.update(patch, "Recuperar edición anterior", false);
        } catch { /* Leave legacy data untouched if it cannot be migrated. */ }
    }, [doc.ready, currentTask, linkedLayerTask, currentTaskId, currentIndex, doc, state]);

    useEffect(() => {
        let active = true;
        fetch("https://fonts.google.com/metadata/fonts", { cache: "force-cache" })
            .then((response) => response.ok ? response.json() as Promise<{ familyMetadataList?: Array<{ family?: string }> }> : null)
            .then((data) => {
                if (!active || !data?.familyMetadataList) return;
                const remote = data.familyMetadataList.map((item) => item.family).filter((family): family is string => typeof family === "string" && /^[\w .'-]+$/.test(family));
                setGoogleFontFamilies([...new Set([...GOOGLE_FONT_FAMILIES, ...remote])].sort((a, b) => a.localeCompare(b)));
            })
            .catch(() => { /* The curated list remains available offline. */ });
        return () => { active = false; };
    }, []);
    const visualKey = JSON.stringify({ taskId: currentTaskId, index: currentIndex, layerTaskId, layerOrder, layerVisibility, layerTransforms, deletedLayerIndexes, textLayers, layerSet });
    const interactivePreview = tool === "text" || (tool === "layers" && reliableLayerSet);
    const fontKey = textLayers.filter(item => item.visible).map(item => `${item.fontFamily}:${item.fontWeight}:${item.fontSize}`).join("|");
    useEffect(() => {
        if (!interactivePreview) return;
        for (const text of textLayers) if (text.visible) void ensureEditorFont(text);
        // Font loading is keyed by typography; moving a layer does not reload it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fontKey, interactivePreview]);
    useEffect(() => {
        if (!doc.ready || !currentTaskId || (layerTaskId && !layerSet) || interactivePreview) return;
        let active = true;
        void renderEditorSnapshot(state, layerSet).then(result => {
            if (!active) return;
            setRenderError("");
            const url = URL.createObjectURL(result.blob);
            setComposition({ url, key: visualKey, bounds: result.bounds });
            setDimensions({ width: result.width, height: result.height });
        }).catch(cause => { if (active) setRenderError(cause instanceof Error ? cause.message : "No se pudo preparar la composición."); });
        return () => { active = false; };
        // Draft instructions and tool selection do not change the rendered artwork.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visualKey, doc.ready, interactivePreview]);
    useEffect(() => {
        const url = composition?.url;
        return () => { if (url) URL.revokeObjectURL(url); };
    }, [composition?.url]);

    const fileTaskIds = new Set(doc.history.entries.map(entry => entry.snapshot.taskId));
    const legacySharedView = !documentId && doc.id === `${documentSource.taskId}-${documentSource.index}`;
    const versions = rootId ? tasks.filter((task) => !isLayerTask(task) && !task.reuse_state?.editor_internal && task.status === "COMPLETED" && task.reuse_state?.edit_root_task_id === rootId && (legacySharedView || fileTaskIds.has(task.task_id))).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];
    const originUrl = rootId ? `/api/download/${encodeURIComponent(rootId)}?index=${rootIndex}` : imageUrl;
    const rootPrompt = tasks.find((task) => task.task_id === rootId)?.prompt ?? (rootId === taskId ? prompt ?? "" : "");
    const history: Version[] = rootId ? [{ id: rootId, url: originUrl, label: "Original", prompt: rootPrompt, index: rootIndex }, ...versions.map((task, position) => {
        const notes = task.reuse_state?.edit_comments;
        const firstNote = Array.isArray(notes) && typeof notes[0]?.text === "string" ? notes[0].text : "";
        return { id: task.task_id, url: `/api/download/${encodeURIComponent(task.task_id)}?index=0`, label: `Versión ${position + 1}`, prompt: String(task.reuse_state?.edit_instruction || firstNote || (task.reuse_state?.edit_mode === "erase" ? "Borrar partes" : task.prompt || "")), index: 0, parentId: typeof task.reuse_state?.edit_parent_task_id === "string" ? task.reuse_state.edit_parent_task_id : rootId };
    })] : [];
    const visibleHistory = currentUrl && currentTaskId && !history.some((item) => item.id === currentTaskId && item.index === currentIndex)
        ? [...history, { id: currentTaskId, url: currentUrl, label: history.length ? `Versión ${history.length}` : "Original", prompt: "", index: currentIndex }]
        : history;
    const selectedVersion = visibleHistory.find((item) => item.id === currentTaskId && item.index === currentIndex);
    const activeTool = EDIT_TOOLS.find((item) => item.id === tool) ?? EDIT_TOOLS[0];
    const selectedModel = models.find((item) => item.id === model);
    const outpaintRatios = selectedModel?.supportsExpand ? (selectedModel.aspectRatios ?? []).filter((ratio): ratio is OutpaintRatio => OUTPAINT_RATIOS.includes(ratio as OutpaintRatio)) : [];
    let outpaintPlan: ReturnType<typeof planOutpaint> | null = null;
    let outpaintError = "";
    if (dimensions.width && dimensions.height && Object.values(outpaintPadding).some(Boolean)) {
        try { outpaintPlan = planOutpaint(dimensions.width, dimensions.height, outpaintPadding, outpaintRatios); }
        catch (cause) { outpaintError = cause instanceof Error ? cause.message : "No se puede expandir esta área."; }
    }
    const outpaintQuoteRatio = outpaintPlan?.ratio;
    useEffect(() => {
        if (tool !== "expand" || !configured || !model || !outpaintQuoteRatio) return;
        if (selectedModel?.provider !== "openrouter") return;
        const controller = new AbortController();
        const query = new URLSearchParams({ provider: "openrouter", model: selectedModel.providerModelId ?? model, connectionId: selectedModel.connectionId ?? "", aspectRatio: outpaintQuoteRatio, quality });
        // eslint-disable-next-line react-hooks/set-state-in-effect -- status of the external price request
        setOutpaintPrice("Consultando precio…");
        fetch(`/api/billing/price?${query}`, { cache: "no-store", signal: controller.signal })
            .then(async (response) => { if (!response.ok) throw new Error("price unavailable"); return response.json() as Promise<{ minUsd?: number; maxUsd?: number }>; })
            .then((quote) => setOutpaintPrice(typeof quote.minUsd === "number" && typeof quote.maxUsd === "number"
                ? `Salida estimada: USD ${quote.minUsd.toFixed(3)}${quote.maxUsd !== quote.minUsd ? `–${quote.maxUsd.toFixed(3)}` : ""} + entradas`
                : "Precio no disponible; la generación puede tener coste."))
            .catch(() => { if (!controller.signal.aborted) setOutpaintPrice("Precio no disponible; la generación puede tener coste."); });
        return () => controller.abort();
    }, [tool, configured, model, outpaintQuoteRatio, quality, selectedModel?.provider, selectedModel?.providerModelId, selectedModel?.connectionId]);

    useEffect(() => {
        activeCardRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }, [currentTaskId, currentIndex, visibleHistory.length]);
    useEffect(() => {
        const viewport = activeViewport();
        if (!viewport || !currentUrl) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            changeZoom(zoomRef.current + (event.deltaY < 0 ? 10 : -10), event.clientX, event.clientY);
        };
        viewport.addEventListener("wheel", onWheel, { passive: false });
        return () => viewport.removeEventListener("wheel", onWheel);
    }, [currentUrl, tool, layerTaskId]);
    useLayoutEffect(() => {
        const viewport = activeViewport();
        const anchor = pendingZoomAnchor.current;
        if (!viewport || !anchor) return;
        viewport.scrollLeft = (viewport.scrollLeft + anchor.x) * anchor.ratio - anchor.x;
        viewport.scrollTop = (viewport.scrollTop + anchor.y) * anchor.ratio - anchor.y;
        pendingZoomAnchor.current = null;
    }, [zoom]);
    useEffect(() => {
        if (panMode || !panGesture.current) return;
        const viewport = activeViewport();
        if (viewport?.hasPointerCapture(panGesture.current.pointerId)) viewport.releasePointerCapture(panGesture.current.pointerId);
        panGesture.current = null;
        setDraggingCanvas(false);
    }, [panMode]);

    function changeZoom(next: number, clientX?: number, clientY?: number) {
        const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
        const previous = zoomRef.current;
        if (clamped === previous) return;
        const viewport = activeViewport();
        if (viewport) {
            const rect = viewport.getBoundingClientRect();
            pendingZoomAnchor.current = {
                x: clientX === undefined ? rect.width / 2 : clientX - rect.left,
                y: clientY === undefined ? rect.height / 2 : clientY - rect.top,
                ratio: clamped / previous,
            };
        }
        zoomRef.current = clamped;
        setZoom(clamped);
    }

    function startPan(event: React.PointerEvent<HTMLDivElement>) {
        if (!panMode || event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
        if ((event.target as HTMLElement).closest("a")) return;
        const viewport = activeViewport();
        if (!viewport) return;
        panGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, moved: false };
    }

    function movePan(event: React.PointerEvent<HTMLDivElement>) {
        const gesture = panGesture.current;
        if (!panMode || !gesture || gesture.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - gesture.startX;
        const deltaY = event.clientY - gesture.startY;
        if (!gesture.moved && Math.hypot(deltaX, deltaY) < 5) return;
        if (!gesture.moved) {
            gesture.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraggingCanvas(true);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = gesture.scrollLeft - deltaX;
        event.currentTarget.scrollTop = gesture.scrollTop - deltaY;
    }

    function endPan(event: React.PointerEvent<HTMLDivElement>) {
        const gesture = panGesture.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        panGesture.current = null;
        setDraggingCanvas(false);
        if (gesture.moved) {
            suppressCanvasClick.current = true;
            window.setTimeout(() => { suppressCanvasClick.current = false; }, 0);
        }
    }

    function startBorderDrag(side: OutpaintSide, event: React.PointerEvent<HTMLButtonElement>) {
        if (busy || !dimensions.width || !dimensions.height || event.button !== 0) return;
        const rect = sourceImageRef.current?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return;
        event.preventDefault(); event.stopPropagation();
        borderDrag.current = { pointerId: event.pointerId, side, startX: event.clientX, startY: event.clientY, initial: outpaintPadding[side], displayWidth: rect.width, displayHeight: rect.height };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function moveBorderDrag(event: React.PointerEvent<HTMLButtonElement>) {
        const drag = borderDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        const horizontal = drag.side === "left" || drag.side === "right";
        const delta = horizontal ? event.clientX - drag.startX : event.clientY - drag.startY;
        const direction = drag.side === "left" || drag.side === "top" ? -1 : 1;
        const originalSize = horizontal ? dimensions.width : dimensions.height;
        const screenSize = horizontal ? drag.displayWidth : drag.displayHeight;
        const next = Math.max(0, Math.min(originalSize, Math.round(drag.initial + direction * delta * originalSize / screenSize)));
        setOutpaintPadding((current) => current[drag.side] === next ? current : { ...current, [drag.side]: next });
    }

    function endBorderDrag(event: React.PointerEvent<HTMLButtonElement>) {
        if (borderDrag.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        borderDrag.current = null;
    }

    function resetMask(width = dimensions.width, height = dimensions.height) {
        const overlay = overlayRef.current;
        if (overlay) { overlay.width = width; overlay.height = height; overlay.getContext("2d")?.clearRect(0, 0, width, height); }
        const mask = document.createElement("canvas"); mask.width = width; mask.height = height;
        const context = mask.getContext("2d");
        if (context) { context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); }
        maskRef.current = mask; setPainted(false);
        if (tool === "mask" || tool === "erase") doc.update(previous => ({ ...previous, strokes: { ...previous.strokes, [tool]: [] } }), "Limpiar selección", false);
    }

    function restoreStrokes(width: number, height: number) {
        const overlay = overlayRef.current;
        if (!overlay || !width || !height) return;
        overlay.width = width; overlay.height = height;
        const mask = document.createElement("canvas"); mask.width = width; mask.height = height;
        const context = mask.getContext("2d");
        if (context) { context.fillStyle = "white"; context.fillRect(0, 0, width, height); }
        maskRef.current = mask;
        const strokes = tool === "mask" || tool === "erase" ? state.strokes[tool] : [];
        for (const stroke of strokes) {
            for (const [canvas, erase] of [[overlay, false], [mask, true]] as const) {
                const ctx = canvas.getContext("2d"); if (!ctx) continue;
                ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
                ctx.strokeStyle = erase ? "#000" : "rgba(239,68,68,.5)";
                ctx.lineWidth = stroke.radius * width * 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
                ctx.beginPath();
                stroke.points.forEach(([x, y], i) => i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height));
                ctx.stroke();
                if (stroke.points.length === 1) paintAt(canvas, stroke.points[0][0] * width, stroke.points[0][1] * height, stroke.radius * width, erase);
            }
        }
        setPainted(strokes.length > 0);
    }
    useEffect(() => {
        restoreStrokes(dimensions.width, dimensions.height);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.strokes, tool, dimensions.width, dimensions.height, currentTaskId]);

    function finishStroke() {
        drawing.current = false; lastPoint.current = null;
        const stroke = strokeGesture.current; strokeGesture.current = null;
        if (stroke?.points.length && (tool === "mask" || tool === "erase")) doc.update(previous => ({ ...previous, strokes: { ...previous.strokes, [tool]: [...previous.strokes[tool], stroke] } }), tool === "mask" ? "Pintar selección" : "Seleccionar para borrar", false);
    }

    function imageLoaded(event: React.SyntheticEvent<HTMLImageElement>) {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        setDimensions({ width, height });
        restoreStrokes(width, height);
        requestAnimationFrame(() => activeCardRef.current?.scrollIntoView({ behavior: "auto", inline: "center", block: "center" }));
    }

    function pointerPoint(event: React.PointerEvent<HTMLCanvasElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * dimensions.width / rect.width, y: (event.clientY - rect.top) * dimensions.height / rect.height };
    }

    function draw(event: React.PointerEvent<HTMLCanvasElement>) {
        if (!drawing.current || !maskRef.current || !overlayRef.current || (tool !== "mask" && tool !== "erase")) return;
        const { x, y } = pointerPoint(event);
        const radius = Math.max(4, dimensions.width * brush / 200);
        if (!strokeGesture.current) strokeGesture.current = { radius: radius / dimensions.width, points: [] };
        if (strokeGesture.current.points.length < 10000) strokeGesture.current.points.push([Math.max(0, Math.min(1, x / dimensions.width)), Math.max(0, Math.min(1, y / dimensions.height))]);
        if (lastPoint.current) {
            for (const [canvas, erase] of [[overlayRef.current, false], [maskRef.current, true]] as const) {
                const context = canvas.getContext("2d");
                if (!context) continue;
                context.globalCompositeOperation = erase ? "destination-out" : "source-over";
                context.strokeStyle = erase ? "#000" : "rgba(239,68,68,.5)";
                context.lineWidth = radius * 2; context.lineCap = "round"; context.lineJoin = "round";
                context.beginPath(); context.moveTo(lastPoint.current.x, lastPoint.current.y); context.lineTo(x, y); context.stroke();
            }
        }
        paintAt(overlayRef.current, x, y, radius, false);
        paintAt(maskRef.current, x, y, radius, true);
        lastPoint.current = { x, y }; setPainted(true);
    }

    function selectVersion(id: string, _url: string, nextIndex = 0) {
        if (id === currentTaskId && nextIndex === currentIndex) return;
        const savedVersion = [...doc.history.entries].reverse().find(entry => entry.snapshot.taskId === id && entry.snapshot.index === nextIndex);
        if (savedVersion) doc.selectRevision(savedVersion.id);
        else doc.update(blankEditorSnapshot(id, nextIndex), "Versión de imagen", false);
        setSelectedComment(""); setSelectedTextLayerId(""); setReference(null); setError("");

    }

    function addComment(event: React.MouseEvent<HTMLButtonElement>) {
        if (tool !== "comments" || comments.length >= 8 || !dimensions.width) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const id = crypto.randomUUID();
        setComments((current) => [...current, { id, x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), text: "" }]);
        setSelectedComment(id); setError("");
    }

    function selectTool(next: Tool) {

        setTool(next); setPanMode(false); setError("");
    }

    function moveLayer(index: number, direction: -1 | 1) {
        if (isLockedLayer(index)) return;
        setLayerOrder((current) => {
            const order = current.length ? [...current] : orderedLayers.map((layer) => layer.index);
            const position = order.indexOf(index);
            const nextPosition = position + direction;
            if (position < 0 || nextPosition < 0 || nextPosition >= order.length) return order;
            if (isLockedLayer(order[nextPosition])) return order;
            [order[position], order[nextPosition]] = [order[nextPosition], order[position]];
            return order;
        });
    }

    function layerTransform(index: number): LayerTransform {
        return layerTransforms[index] ?? { x: 0, y: 0, scale: 1 };
    }

    function beginDrag(event: React.PointerEvent<HTMLDivElement>, canvas: HTMLElement, initialX: number, initialY: number, baseTransform = ""): DragGesture | null {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const target = event.currentTarget;
        const gesture: DragGesture = { pointerId: event.pointerId, target, captureTarget: target, startX: event.clientX, startY: event.clientY, initialX, initialY, x: initialX, y: initialY, rectWidth: rect.width, rectHeight: rect.height, displayWidth: canvas.clientWidth, displayHeight: canvas.clientHeight, frame: null, baseTransform };
        target.setPointerCapture(event.pointerId);
        target.style.willChange = "transform";
        return gesture;
    }

    function previewDrag(drag: DragGesture, event: React.PointerEvent<HTMLDivElement>, minimum: number, maximum: number) {
        if (drag.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        drag.x = Math.max(minimum, Math.min(maximum, drag.initialX + (event.clientX - drag.startX) / drag.rectWidth * 100));
        drag.y = Math.max(minimum, Math.min(maximum, drag.initialY + (event.clientY - drag.startY) / drag.rectHeight * 100));
        if (drag.frame !== null) return;
        drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            const dx = (drag.x - drag.initialX) / 100 * drag.displayWidth;
            const dy = (drag.y - drag.initialY) / 100 * drag.displayHeight;
            drag.target.style.transform = `${drag.baseTransform} translate3d(${dx}px, ${dy}px, 0)`;
        });
    }

    function finishDrag(drag: DragGesture, commit: () => void, cancelled: boolean) {
        if (drag.frame !== null) cancelAnimationFrame(drag.frame);
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
        if (!cancelled && (drag.x !== drag.initialX || drag.y !== drag.initialY)) flushSync(commit);
        drag.target.style.transform = "";
        drag.target.style.willChange = "";
    }

    useEffect(() => () => {
        for (const drag of [layerDrag.current, textDrag.current]) if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
    }, []);

    function startLayerDrag(layer: ImageLayerMetadata, event: React.PointerEvent<HTMLDivElement>) {
        setSelectedLayerIndex(layer.index);
        if (panMode || tool !== "layers") return;
        event.stopPropagation();
        if (isLockedLayer(layer.index) || busy || event.button !== 0 || !layerCanvasRef.current) return;
        event.preventDefault();
        const transform = layerTransform(layer.index);
        const drag = beginDrag(event, layerCanvasRef.current, transform.x, transform.y);
        if (drag) layerDrag.current = { ...drag, index: layer.index, scale: transform.scale };
    }

    function moveLayerDrag(event: React.PointerEvent<HTMLDivElement>) {
        const drag = layerDrag.current;
        if (drag) previewDrag(drag, event, -100, 100);
    }

    function endLayerDrag(event: React.PointerEvent<HTMLDivElement>) {
        const drag = layerDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.type === "pointerup") previewDrag(drag, event, -100, 100);
        finishDrag(drag, () => doc.update(previous => ({ ...previous, layerTransforms: { ...previous.layerTransforms, [drag.index]: { x: drag.x, y: drag.y, scale: drag.scale } } }), "Mover capa", false), event.type === "pointercancel");
        layerDrag.current = null;
    }

    function resetLayerTransform(index: number) {
        setLayerTransforms((current) => {
            const next = { ...current };
            delete next[index];
            return next;
        });
    }

    function deleteLayer(index: number) {
        if (isLockedLayer(index) || busy) return;
        setDeletedLayerIndexes((current) => ({ ...current, [index]: true }));
        setLayerVisibility((current) => ({ ...current, [index]: false }));
        if (selectedLayerIndex === index) {
            const next = orderedLayers.find((layer) => layer.index !== index && !isLockedLayer(layer.index));
            setSelectedLayerIndex(next?.index ?? layerSet?.baseIndex ?? 0);
        }
    }

    function updateTextLayer(id: string, patch: Partial<TextLayer>) {
        setTextLayers((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    }

    function addTextLayer() {
        if (!currentUrl) return;
        const item: TextLayer = { id: crypto.randomUUID(), text: "Escribe aquí", x: 50, y: 50, fontFamily: "Manrope", fontSize: 54, fontWeight: 700, color: "#ffffff", align: "center", visible: true };
        setTextLayers((current) => [...current, item]); setSelectedTextLayerId(item.id); setTool("text"); setPanMode(false); setError("");
    }

    function removeTextLayer(id: string) {
        setTextLayers((current) => current.filter((item) => item.id !== id));
        if (selectedTextLayerId === id) setSelectedTextLayerId("");
    }

    function startTextDrag(layer: TextLayer, event: React.PointerEvent<HTMLDivElement>) {
        if (panMode || busy || tool !== "text" || !layer.visible || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); setSelectedTextLayerId(layer.id);
        const canvas = layerCanvasRef.current ?? sourceImageRef.current?.parentElement;
        if (!canvas) return;
        const drag = beginDrag(event, canvas, layer.x, layer.y, "translate(-50%, -50%)");
        if (drag) textDrag.current = { ...drag, id: layer.id };
    }

    function moveTextDrag(event: React.PointerEvent<HTMLDivElement>) {
        const drag = textDrag.current;
        if (drag) previewDrag(drag, event, 0, 100);
    }

    function endTextDrag(event: React.PointerEvent<HTMLDivElement>) {
        const drag = textDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.type === "pointerup") previewDrag(drag, event, 0, 100);
        finishDrag(drag, () => doc.update(previous => ({ ...previous, textLayers: previous.textLayers.map(item => item.id === drag.id ? { ...item, x: drag.x, y: drag.y } : item) }), "Mover texto", false), event.type === "pointercancel");
        textDrag.current = null;
    }

    function renderTextLayers(width: number) {
        if (tool !== "text" && tool !== "layers") return null;
        return textLayers.filter((item) => item.visible).map((item) => {
            const selected = selectedTextLayerId === item.id;
            return <div key={item.id} role="button" tabIndex={0} aria-label={`Texto: ${item.text}`} onPointerDown={(event) => startTextDrag(item, event)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedTextLayerId(item.id); setPanMode(false); } }} className={`absolute z-[40] box-border max-w-[90%] select-none border px-0.5 ${selected && tool === "text" ? "border-[#ff4d4d]" : "border-transparent"} ${panMode || tool !== "text" ? "pointer-events-none" : "pointer-events-auto cursor-move"}`} style={{ left: `${item.x}%`, top: `${item.y}%`, transform: "translate(-50%, -50%)", width: "max-content", fontFamily: `'${item.fontFamily.replace(/['"\\]/g, "")}', sans-serif`, fontWeight: item.fontWeight, fontSize: `${item.fontSize / width * 100}cqw`, lineHeight: 1.05, color: item.color, textAlign: item.align, whiteSpace: "pre-wrap", overflowWrap: "anywhere", touchAction: "none" }}>
                {item.text || " "}
                {selected && tool === "text" && <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap bg-[#c62828] px-1.5 py-1 text-[10px] font-semibold text-white">Texto · arrastra para mover</span>}
            </div>;
        });
    }

    async function prepareSource() {
        if (!await doc.save()) throw new Error("Guarda la edición antes de generar. Revisa el aviso de guardado.");
        if (!layerTaskId && !textLayers.length) return { taskId: currentTaskId, index: currentIndex };
        const rendered = await renderEditorSnapshot(state, layerSet);
        const response = await fetch(`/api/images/editor-snapshot?taskId=${encodeURIComponent(currentTaskId)}&index=${currentIndex}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: rendered.blob });
        const result = await response.json();
        if (!response.ok || !result.taskId) throw new Error(result.error || "No se pudo guardar la composición.");
        return { taskId: result.taskId as string, index: 0 };
    }

    async function downloadComposition() {
        try {
            const result = await renderEditorSnapshot(state, layerSet);
            const url = URL.createObjectURL(result.blob);
            const link = document.createElement("a"); link.href = url; link.download = `${doc.title || "edicion"}.png`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo descargar."); }
    }

    async function decomposeLayers() {
        if (inFlight.current || !currentTaskId) return;
        inFlight.current = true; setBusy(true); setError("");
        try {
            if (!await doc.save()) throw new Error("No se pudo guardar la edición actual.");
            const source = layerTask && layerSet && !reliableLayerSet
                ? { taskId: layerTask.task_id, index: layerSet.referenceIndex ?? 0 }
                : await prepareSource();
            const response = await fetch("/api/images/layers", {
                method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
                body: JSON.stringify({ operation: "decompose", source: { type: "task", ...source }, prompt: layerPrompt.trim() || undefined, size: layerSize }),
            });
            const result = await response.json().catch(() => ({})) as { taskId?: string; error?: string };
            if (!response.ok || !result.taskId) throw new Error(result.error || "No se pudo separar la imagen en capas.");
            doc.update({ ...blankEditorSnapshot(source.taskId, source.index), layerTaskId: result.taskId, layerVisibility: { 0: false } }, "Separar en capas", false); setSelectedLayerIndex(1); setLayerEditPrompt("");
            await revalidateImageTasks();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo separar la imagen en capas."); }
        finally { inFlight.current = false; setBusy(false); }
    }

    async function recoverLayers(jobId: string) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setRecoveringLayers(true); setError("");
        try {
            if (!await doc.save()) throw new Error("Guarda la edición antes de recuperar las capas.");
            const response = await fetch("/api/images/layers", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ operation: "recover", jobId }) });
            const result = await response.json();
            if (!response.ok || !result.taskId) throw new Error(result.error || "No se pudieron recuperar las capas.");
            doc.update({ ...blankEditorSnapshot(currentTaskId, currentIndex), layerTaskId: result.taskId, layerVisibility: { 0: false } }, "Recuperar capas sin regenerar", false);
            setLayerRecoveries(jobs => jobs.filter(job => job.id !== jobId));
            await revalidateImageTasks();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron recuperar las capas."); }
        finally { inFlight.current = false; setBusy(false); setRecoveringLayers(false); }
    }

    async function editLayer() {
        if (inFlight.current || !layerTaskId || !selectedLayerEditable || !layerEditPrompt.trim()) return;
        inFlight.current = true; setBusy(true); setError("");
        try {
            if (!await doc.save()) throw new Error("No se pudo guardar la edición antes de editar la capa.");
            const response = await fetch("/api/images/layers", {
                method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
                body: JSON.stringify({ operation: "edit-layer", layerTaskId, layerIndex: selectedLayerIndex, prompt: layerEditPrompt.trim() }),
            });
            const result = await response.json().catch(() => ({})) as { taskId?: string; error?: string };
            if (!response.ok || !result.taskId) throw new Error(result.error || "No se pudo editar la capa.");
            setLayerTaskId(result.taskId); setLayerEditPrompt("");
            await revalidateImageTasks();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo editar la capa."); }
        finally { inFlight.current = false; setBusy(false); }
    }

    async function uploadSource(file: File | undefined) {
        if (!file || inFlight.current) return;
        inFlight.current = true; setUploading(true); setError("");
        try {
            if (!await doc.save()) throw new Error("Guarda la edición actual antes de abrir otra imagen.");
            const body = new FormData(); body.set("image", file);
            const response = await fetch("/api/images/source", { method: "POST", body });
            const result = await response.json().catch(() => ({})) as { taskId?: string; imageUrl?: string; error?: string };
            if (!response.ok || !result.taskId || !result.imageUrl) throw new Error(result.error || "No se pudo subir la imagen.");
            await revalidateImageTasks();
            setDocumentSource({ taskId: result.taskId, index: 0 }); migratedLegacy.current = false;
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo subir la imagen."); }
        finally { inFlight.current = false; setUploading(false); }
    }

    async function removeBackground() {
        if (inFlight.current || !currentTaskId || !backgroundModel) return;
        inFlight.current = true; setBusy(true); setError("");
        try {
            const source = await prepareSource();
            const response = await fetch("/api/images/remove-background", {
                method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
                body: JSON.stringify({ source: { type: "task", ...source }, modelId: backgroundModel }),
            });
            const result = await response.json().catch(() => ({})) as { taskId?: string; imageUrl?: string; error?: string };
            if (!response.ok || !result.taskId || !result.imageUrl) throw new Error(result.error || "No se pudo quitar el fondo.");
            selectVersion(result.taskId, result.imageUrl);
            await revalidateImageTasks();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo quitar el fondo."); }
        finally { inFlight.current = false; setBusy(false); }
    }

    async function submit() {
        if (inFlight.current) return;
        if (!currentTaskId) { setError("Agrega una imagen antes de generar una versión."); return; }
        if (!configured) { setError("Conecta un proveedor de imágenes en Conexiones de APIs y comprueba que haya modelos disponibles."); return; }
        if (!selectedModel) { setError("Selecciona un modelo de imagen disponible."); return; }
        if (tool === "expand" && !selectedModel.supportsExpand) { setError("La expansión de bordes está disponible actualmente con modelos de OpenRouter."); return; }
        if (tool === "comments" && !comments.length) { setError("Añade al menos un comentario sobre la imagen."); return; }
        if (tool === "comments" && comments.some((item) => !item.text.trim())) { setError("Escribe el cambio de cada comentario o elimínalo."); return; }
        if ((tool === "mask" || tool === "erase") && !painted) { setError("Pinta primero la zona que quieres editar."); return; }
        if ((tool === "prompt" || tool === "mask") && !instruction.trim()) { setError("Escribe el cambio que quieres realizar."); return; }
        if (tool === "expand" && !outpaintPlan) { setError(outpaintError || "Arrastra al menos un borde de la imagen para definir el área nueva."); return; }
        if (tool === "expand" && !instruction.trim()) { setError("Escribe qué quieres generar en el área ampliada."); return; }
        inFlight.current = true; setBusy(true); setError("");
        try {
            const source = await prepareSource();
            const hasMask = (tool === "mask" || tool === "erase") && painted;
            const body = new FormData();
            body.set("prompt", instruction.trim()); body.set("model", model); body.set("quality", quality); body.set("aspectRatio", tool === "expand" ? "auto" : aspectRatio);
            body.set("operation", tool === "expand" ? "expand" : tool === "erase" ? "erase" : "edit");
            if (tool === "expand") { body.set("padding", JSON.stringify(outpaintPadding)); body.set("preserveOriginal", String(preserveOriginal)); }
            body.set("comments", JSON.stringify(tool === "comments" ? comments.map(({ x, y, text }) => ({ x, y, text: text.trim() })) : []));
            body.set("sourceTaskId", source.taskId); body.set("sourceIndex", String(source.index));
            if (reference) body.set("reference", reference);
            if (hasMask) {
                const blob = await new Promise<Blob | null>((resolve) => { if (maskRef.current) maskRef.current.toBlob(resolve, "image/png"); else resolve(null); });
                if (!blob) throw new Error("No se pudo preparar la máscara.");
                body.set("mask", blob, "mascara.png");
            }
            const response = await fetch("/api/images/edit", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body });
            const result = await response.json().catch(() => ({})) as { taskId?: string; rootTaskId?: string; rootIndex?: number; imageUrl?: string; error?: string; warning?: string };
            if (!response.ok || !result.taskId || !result.imageUrl) throw new Error(result.error || "No se pudo editar la imagen.");
            selectVersion(result.taskId, result.imageUrl);
            if (tool === "expand") { setTool("expand"); setPanMode(false); }
            await revalidateImageTasks();
            if (result.warning) setError(result.warning);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo editar la imagen."); }
        finally { inFlight.current = false; setBusy(false); }
    }

    const modelOptions = models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>);

    return <div className={embedded ? "h-[100dvh] overflow-hidden bg-black p-2 pt-16 text-white sm:p-4 sm:pt-16" : "fixed inset-0 z-[60] flex items-center justify-center overflow-hidden bg-black/95 p-2 text-white sm:p-4"} {...(!embedded ? { role: "dialog", "aria-modal": true, "aria-label": "Editar imagen con IA" } : {})}>
        <div className={`mx-auto flex h-full w-full max-w-[1900px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b0b] shadow-2xl`}>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#111] px-4 py-3 sm:px-6">
                <div className="flex min-w-0 items-center gap-2"><Sparkles className="h-5 w-5 shrink-0 text-[#ff4d4d]" /><div className="min-w-0"><h2 className="truncate text-sm font-bold sm:text-base">Editor de imágenes</h2><p className="hidden text-[11px] text-white/45 sm:block">{doc.status}</p></div></div>
                <div className="flex shrink-0 items-center gap-2">{onRequestImage && <button type="button" onClick={() => void doc.save().then(saved => { if (saved) onRequestImage(); })} disabled={busy || !doc.ready} className="flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold hover:bg-white/5 disabled:opacity-45"><ImagePlus className="h-4 w-4" /><span className="hidden sm:inline">Archivos e imágenes</span></button>}<button type="button" onClick={() => void doc.save().then(saved => { if (saved) onClose(); })} disabled={busy} aria-label={embedded ? "Volver al inicio" : "Cerrar editor"} className="flex items-center gap-2 rounded-lg p-2 text-sm text-white/70 hover:bg-white/10">{embedded ? <><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">Inicio</span></> : <X className="h-5 w-5" />}</button></div>
            </header>
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2 text-xs">
                <input aria-label="Nombre de la edición" value={doc.title} disabled={!doc.ready || busy} onChange={event => doc.setTitle(event.target.value)} className="min-w-32 flex-1 rounded-lg bg-white/5 px-3 py-2" />
                <button type="button" disabled={!doc.ready || busy || !doc.history.entries.find(entry => entry.id === doc.history.cursor)?.parentId} onClick={() => { const entry = doc.history.entries.find(item => item.id === doc.history.cursor); if (entry?.parentId) doc.selectRevision(entry.parentId); }} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Deshacer</button>
                <button type="button" disabled={!doc.ready || busy || !doc.history.entries.some(entry => entry.parentId === doc.history.cursor)} onClick={() => { const next = [...doc.history.entries].reverse().find(entry => entry.parentId === doc.history.cursor); if (next) doc.selectRevision(next.id); }} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Rehacer</button>
                <button type="button" onClick={() => setShowHistory(value => !value)} className="rounded-lg border border-white/15 px-3 py-2">Historial · {doc.history.entries.length}</button>
                <button type="button" disabled={!doc.ready || busy || !currentTaskId} onClick={() => void doc.save()} className="rounded-lg bg-[#c62828] px-3 py-2 disabled:opacity-40">Guardar edición</button>
                <button type="button" disabled={!doc.ready || busy || !currentTaskId} onClick={() => void doc.saveCopy("duplicate").then(id => { if (id) onOpenDocument?.(id); })} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40" title="Crea otro archivo con todo el historial y las capas">Duplicar archivo</button>
                <button type="button" disabled={!doc.ready || busy || !currentTaskId} onClick={() => void doc.saveCopy("fork").then(id => { if (id) onOpenDocument?.(id); })} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40" title="Guarda la versión seleccionada como otro archivo editable">Nueva edición desde esta versión</button>
                {onNewFromOriginal && <button type="button" disabled={!doc.ready || busy || !currentTaskId} onClick={() => void doc.save().then(saved => { if (saved) onNewFromOriginal(); })} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40" title="Abre un archivo independiente con la imagen de partida">Nueva desde original</button>}
                <button type="button" disabled={!doc.ready || busy || !currentTaskId} onClick={() => void downloadComposition()} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Descargar</button>
            </div>
            {doc.saveError && <div className="flex items-center gap-3 px-4 py-2 text-xs text-amber-200"><p role="alert">{doc.saveError}</p>{doc.ready && <button type="button" disabled={busy} onClick={() => void doc.saveCopy()} className="shrink-0 rounded-lg border border-amber-200/40 px-3 py-2">Guardar como copia</button>}</div>}
            {showHistory && <div aria-label="Historial de edición" className="flex max-h-32 shrink-0 flex-wrap gap-2 overflow-y-auto border-b border-white/10 p-3">{[...doc.history.entries].reverse().map((entry, position) => <button type="button" key={entry.id} disabled={busy || !doc.ready} onClick={() => doc.selectRevision(entry.id)} className={`rounded-lg border px-3 py-2 text-xs ${entry.id === doc.history.cursor ? "border-[#ff4d4d] bg-[#c62828]/20" : "border-white/15"}`}>{doc.history.entries.length - position}. {entry.label}</button>)}</div>}
            <div className={`relative flex min-h-0 flex-1 flex-col-reverse md:flex-row ${!doc.ready || busy ? "pointer-events-none" : ""}`}>
                {!doc.ready && <div role="status" className="absolute inset-0 z-50 grid place-items-center bg-black/80">Abriendo edición guardada…</div>}
                <main className="relative min-h-[240px] min-w-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_center,_#1c1c1c_0,_#0a0a0a_68%)]">
                    {!currentUrl ? <div className="flex h-full items-center justify-center p-6"><div className="flex w-full max-w-lg flex-col items-center rounded-2xl border border-dashed border-white/20 bg-[#141414]/90 px-6 py-12 text-center"><div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl border border-white/15 bg-[#1b1b1b]"><ImagePlus className="h-8 w-8 text-[#ff4d4d]" /></div><h3 className="text-xl font-semibold">Tu lienzo está listo</h3><p className="mt-2 max-w-sm text-sm text-white/50">Abre un archivo de edición o selecciona una imagen para empezar uno nuevo.</p>{onRequestImage ? <button type="button" onClick={onRequestImage} className="mt-6 rounded-xl bg-[#c62828] px-6 py-3 text-sm font-bold text-white hover:bg-[#a92121]">Abrir archivos e imágenes</button> : <label className="mt-6 cursor-pointer rounded-xl bg-[#c62828] px-6 py-3 text-sm font-bold text-white hover:bg-[#a92121]">Subir imagen<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" onChange={(event) => { void uploadSource(event.target.files?.[0]); event.target.value = ""; }} /></label>}</div></div> : <div ref={viewportRef} tabIndex={0} aria-label="Lienzo de versiones; usa la mano para arrastrar y Control o Comando con la rueda para hacer zoom" onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onClickCapture={(event) => { if (suppressCanvasClick.current) { event.preventDefault(); event.stopPropagation(); suppressCanvasClick.current = false; } }} className={`h-full w-full overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ff4d4d] ${(tool === "layers" || tool === "text") && layerTask && reliableLayerSet ? "hidden" : ""} ${panMode ? `select-none ${draggingCanvas ? "cursor-grabbing [&_button]:cursor-grabbing" : "cursor-grab [&_button]:cursor-grab"}` : ""}`}><div className="flex min-h-[250%] min-w-[250%] w-max items-center justify-center gap-8 p-16 sm:gap-10" style={{ zoom: zoom / 100 }}>{visibleHistory.map((item, position) => {
                        const selected = item.id === currentTaskId && item.index === currentIndex;
                        const expandingHere = selected && tool === "expand" && !panMode && dimensions.width > 0 && dimensions.height > 0;
                        const image = <div onPointerMove={moveTextDrag} onPointerUp={endTextDrag} onPointerCancel={endTextDrag} className={`relative inline-block ${selected ? "border border-[#ff4d4d] shadow-[0_0_0_2px_rgba(198,40,40,.28),0_0_24px_rgba(198,40,40,.18)]" : "border border-transparent"}`}>
                            {expandingHere && <div aria-label="Área nueva que se generará" className="pointer-events-none absolute z-0 border-2 border-dashed border-[#ff4d4d] bg-[#292929] bg-[linear-gradient(45deg,#393939_25%,transparent_25%),linear-gradient(-45deg,#393939_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#393939_75%),linear-gradient(-45deg,transparent_75%,#393939_75%)] bg-[length:18px_18px] shadow-[0_0_28px_rgba(255,77,77,.22)]" style={{ left: `${-outpaintPadding.left / dimensions.width * 100}%`, top: `${-outpaintPadding.top / dimensions.height * 100}%`, width: `${(dimensions.width + outpaintPadding.left + outpaintPadding.right) / dimensions.width * 100}%`, height: `${(dimensions.height + outpaintPadding.top + outpaintPadding.bottom) / dimensions.height * 100}%` }} />}
                            <img ref={selected ? sourceImageRef : undefined} key={`${item.id}:${item.index}`} src={selected && !interactivePreview && composition && composition.key === visualKey ? composition.url : item.url} alt={`${item.label} de la imagen`} draggable={false} onLoad={selected ? imageLoaded : undefined} className="relative z-10 block max-h-[min(74dvh,900px)] max-w-[min(76vw,560px)] object-contain shadow-2xl" />
                            {selected && <><canvas ref={overlayRef} className={`absolute inset-0 z-20 h-full w-full touch-none ${!panMode && (tool === "mask" || tool === "erase") ? "cursor-crosshair" : "pointer-events-none"}`} aria-label="Pinta la zona a editar o borrar" onPointerDown={(event) => { drawing.current = true; lastPoint.current = null; strokeGesture.current = null; event.currentTarget.setPointerCapture(event.pointerId); draw(event); }} onPointerMove={draw} onPointerUp={finishStroke} onPointerCancel={finishStroke} /><div className={`absolute inset-0 z-20 ${!panMode && tool === "comments" ? "" : "pointer-events-none"}`}><button type="button" aria-label="Añadir comentario en esta posición" disabled={panMode || tool !== "comments" || comments.length >= 8} onClick={addComment} className={`absolute inset-0 h-full w-full ${!panMode && tool === "comments" ? "cursor-crosshair" : "pointer-events-none"}`} />{!panMode && tool === "comments" && comments.map((comment, noteIndex) => <button key={comment.id} type="button" title={comment.text || `Comentario ${noteIndex + 1}`} onClick={() => setSelectedComment(comment.id)} style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }} className="pointer-events-auto absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-[#c62828] text-xs font-bold text-white shadow-lg">{noteIndex + 1}</button>)}</div></>}
                            {selected && tool === "text" && <div className="pointer-events-none absolute inset-0 z-[40]" style={{ containerType: "inline-size" }}>{renderTextLayers(dimensions.width || 1)}</div>}
                            {expandingHere && (["left", "right", "top", "bottom"] as OutpaintSide[]).map((side) => <button key={side} type="button" aria-label={`Estirar borde ${side === "left" ? "izquierdo" : side === "right" ? "derecho" : side === "top" ? "superior" : "inferior"}`} title={`Arrastra para expandir ${side === "left" ? "a la izquierda" : side === "right" ? "a la derecha" : side === "top" ? "hacia arriba" : "hacia abajo"}`} disabled={busy} onPointerDown={(event) => startBorderDrag(side, event)} onPointerMove={moveBorderDrag} onPointerUp={endBorderDrag} onPointerCancel={endBorderDrag} className={`absolute z-30 flex h-9 w-9 touch-none items-center justify-center rounded-full border-2 border-white bg-[#c62828] text-lg font-bold text-white shadow-lg hover:scale-110 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 ${side === "left" || side === "right" ? "cursor-ew-resize" : "cursor-ns-resize"}`} style={{ left: side === "left" ? `${-outpaintPadding.left / dimensions.width * 100}%` : side === "right" ? `${(dimensions.width + outpaintPadding.right) / dimensions.width * 100}%` : "50%", top: side === "top" ? `${-outpaintPadding.top / dimensions.height * 100}%` : side === "bottom" ? `${(dimensions.height + outpaintPadding.bottom) / dimensions.height * 100}%` : "50%", transform: "translate(-50%, -50%)" }}>{side === "left" || side === "right" ? "↔" : "↕"}</button>)}
                        </div>;
                        return <article key={`${item.id}:${item.index}`} ref={selected ? activeCardRef : undefined} aria-label={`${item.label}, ${position + 1} de ${visibleHistory.length}${selected ? ", seleccionada" : ""}`} title={item.prompt || item.label} className="group/image relative shrink-0">
                            {selected ? image : <button type="button" onClick={() => selectVersion(item.id, item.url, item.index)} disabled={busy} aria-label={`Seleccionar ${item.label} para editar`} className="block disabled:opacity-60">{image}</button>}
                            <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-lg bg-black/75 px-2.5 py-1.5 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100">{item.label}{selected && <Check className="h-3.5 w-3.5 text-[#ff4d4d]" />}</span>
                            <a href={`/api/download/${encodeURIComponent(item.id)}?index=${item.index}`} onClick={selected ? (event) => { event.preventDefault(); void downloadComposition(); } : undefined} download title={`Descargar ${item.label}`} aria-label={`Descargar ${item.label}`} className="absolute bottom-3 right-3 rounded-lg bg-black/75 p-2 text-white opacity-0 shadow-lg transition-opacity hover:bg-black focus:opacity-100 group-hover/image:opacity-100 group-focus-within/image:opacity-100"><Download className="h-4 w-4" /></a>
                        </article>;
                    })}{busy && <div role="status" className="flex h-48 w-48 shrink-0 flex-col items-center justify-center gap-3 rounded-2xl bg-[#1d1111] text-center text-xs text-white/70"><Loader2 className="h-6 w-6 animate-spin text-[#ff4d4d]" />{recoveringLayers ? "Recuperando capas sin regenerar…" : "Generando nueva versión…"}</div>}</div></div>}
                    {(tool === "layers" || tool === "text") && layerTask && layerSet && reliableLayerSet && <div ref={layerViewportRef} tabIndex={0} aria-label="Mesa de trabajo de capas; selecciona y arrastra una capa" onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} className={`absolute inset-0 z-[5] flex items-center justify-center overflow-auto bg-[#090909] p-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ff4d4d] ${panMode ? `select-none ${draggingCanvas ? "cursor-grabbing" : "cursor-grab"}` : ""}`}>
                        <div className="flex min-h-full min-w-full items-center justify-center" style={{ zoom: zoom / 100 }}>
                            <div ref={layerCanvasRef} className="relative w-[min(78vw,820px)] max-w-full overflow-hidden border border-white/15 bg-[#101010] bg-[linear-gradient(45deg,#171717_25%,transparent_25%),linear-gradient(-45deg,#171717_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#171717_75%),linear-gradient(-45deg,transparent_75%,#171717_75%)] bg-[length:24px_24px] shadow-2xl" style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}`, containerType: "inline-size" }} onPointerMove={(event) => { moveLayerDrag(event); moveTextDrag(event); }} onPointerUp={(event) => { endLayerDrag(event); endTextDrag(event); }} onPointerCancel={(event) => { endLayerDrag(event); endTextDrag(event); }} aria-label="Lienzo editable de capas">
                                {orderedLayers.map((layer, orderIndex) => {
                                    const transform = layerTransform(layer.index);
                                    const selected = selectedLayerIndex === layer.index;
                                    if (!layerImages[layer.index] || layer.index === referenceIndex || layerVisibility[layer.index] === false) return null;
                                    const frame = layerFrame(layer, layerSet, transform);
                                    const imageStyle = { left: `${frame.left / canvasWidth * 100}%`, top: `${frame.top / canvasHeight * 100}%`, width: `${frame.width / canvasWidth * 100}%`, height: `${frame.height / canvasHeight * 100}%`, zIndex: orderIndex + 1 };
                                    return <div key={`workbench-layer-${layer.index}`} role="button" tabIndex={0} aria-label={`Seleccionar ${layer.name}`} onPointerDown={(event) => startLayerDrag(layer, event)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedLayerIndex(layer.index); } }} className={`absolute select-none ${selected ? "outline outline-1 outline-[#ff4d4d]" : ""} ${isLockedLayer(layer.index) ? "cursor-default" : panMode ? "cursor-grab" : "cursor-move"}`} style={{ ...imageStyle, touchAction: "none" }}>
                                        <img src={layerImages[layer.index]} alt="" draggable={false} className="pointer-events-none h-full w-full object-fill" />
                                            {selected && <span className="pointer-events-none absolute -top-6 left-0 whitespace-nowrap bg-[#c62828] px-1.5 py-1 text-[10px] font-semibold text-white">{layer.name}{isLockedLayer(layer.index) ? " · bloqueada" : ""}</span>}
                                    </div>;
                                })}
                                {renderTextLayers(canvasWidth)}
                            </div>
                        </div>
                    </div>}
                    <nav aria-label="Herramientas de edición" className="absolute inset-x-3 bottom-3 z-10 flex items-center justify-center gap-1 rounded-2xl border border-white/15 bg-[#171717]/95 p-2 shadow-2xl backdrop-blur md:inset-x-auto md:bottom-auto md:left-4 md:top-1/2 md:-translate-y-1/2 md:flex-col"><button type="button" aria-label="Mover lienzo con la mano" title="Mover lienzo con la mano" aria-pressed={panMode} disabled={!currentUrl} onClick={() => setPanMode(true)} className={`grid h-11 w-11 place-items-center rounded-xl transition-colors disabled:opacity-35 ${panMode ? "bg-[#c62828] text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}><Hand className="h-5 w-5" /></button>{EDIT_TOOLS.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={label} title={label} aria-pressed={!panMode && tool === id} disabled={!currentUrl || busy} onClick={() => selectTool(id)} className={`grid h-11 w-11 place-items-center rounded-xl transition-colors disabled:opacity-35 ${!panMode && tool === id ? "bg-[#c62828] text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}><Icon className="h-5 w-5" /></button>)}</nav>
                    {currentUrl && <div role="group" aria-label="Zoom del lienzo" className="absolute bottom-20 right-3 z-10 flex items-center gap-1 rounded-xl border border-white/15 bg-[#171717]/95 p-1.5 shadow-xl backdrop-blur md:bottom-4 md:right-4"><button type="button" title="Alejar" aria-label="Alejar lienzo" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - ZOOM_STEP)} className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30"><ZoomOut className="h-4 w-4" /></button><button type="button" title="Restablecer zoom al 100 %" aria-label={`Zoom ${zoom} %, restablecer al 100 %`} onClick={() => changeZoom(100)} className="min-w-14 rounded-lg px-2 py-2 text-center text-xs font-semibold tabular-nums text-white hover:bg-white/10">{zoom}%</button><button type="button" title="Acercar" aria-label="Acercar lienzo" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + ZOOM_STEP)} className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30"><ZoomIn className="h-4 w-4" /></button><button type="button" title="Restablecer zoom" aria-label="Restablecer zoom" disabled={zoom === 100} onClick={() => changeZoom(100)} className="hidden h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30 sm:grid"><RotateCcw className="h-4 w-4" /></button></div>}
                </main>
                <aside aria-label={`Opciones de ${activeTool.label}`} className="max-h-[38dvh] min-h-0 w-full shrink-0 overflow-y-auto border-b border-white/10 bg-[#141414] p-4 md:max-h-none md:w-[320px] md:border-b-0 md:border-l xl:w-[360px]">
                    <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#c62828]/15 text-[#ff4d4d]"><activeTool.icon className="h-5 w-5" /></div><div><h3 className="text-sm font-bold">{activeTool.label}</h3>{tool !== "layers" && <p className="text-xs text-white/45">{currentUrl ? `${panMode ? "Mano activa · " : "Editando: "}${selectedVersion?.label ?? "imagen seleccionada"}` : "Primero agrega una imagen"}</p>}</div></div>
                    {!currentUrl ? <div className="mt-6 rounded-xl border border-dashed border-white/15 p-4 text-xs text-white/50">Elige una imagen de la galería para activar las herramientas.</div> : tool === "background" ? <section className="mt-6"><p className="text-xs leading-relaxed text-white/55">Crea una nueva versión PNG con fondo transparente. La imagen actual se conserva.</p>{backgroundModels.length ? <><label className="mt-5 block text-xs text-white/70">Modelo de OpenRouter<select aria-label="Modelo para quitar fondo" value={backgroundModel} onChange={(event) => setBackgroundModel(event.target.value)} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white">{backgroundModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" disabled={busy || uploading || !backgroundModel} onClick={() => void removeBackground()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}{busy ? "Procesando…" : "Quitar fondo"}</button></> : <p className="mt-4 text-xs text-white/45">{backgroundMessage || "Buscando modelos compatibles…"}</p>}</section> : tool === "layers" ? <section className="mt-6 space-y-4">
                        {!layerTask || !reliableLayerSet ? <>
                            {layerRecoveries.map(job => <div key={job.id} className="rounded-xl border border-amber-300/30 bg-amber-300/5 p-3 text-xs text-amber-100"><p>Hay una separación pendiente de guardar. Puedes recuperar sus archivos sin solicitar otra generación.</p><button type="button" disabled={busy} onClick={() => void recoverLayers(job.id)} className="mt-3 w-full rounded-lg bg-[#c62828] px-3 py-3 font-bold text-white disabled:opacity-45">Recuperar capas sin regenerar</button></div>)}
                            {layerTask && <p role="alert" className="rounded-xl border border-amber-300/30 bg-amber-300/5 p-3 text-xs leading-relaxed text-amber-200">Esta separación anterior perdió las posiciones de las capas. Vuelve a separar desde la imagen original; la edición anterior quedará en el historial. La nueva separación consume créditos de APIMart.</p>}
                            <p className="text-xs leading-relaxed text-white/55">Seedream 5.0 Pro separa la imagen en una base y capas PNG transparentes para editarlas por separado. La imagen original se conserva.</p>
                            <label className="block text-xs text-white/70">Indicaciones opcionales<textarea value={layerPrompt} onChange={(event) => setLayerPrompt(event.target.value)} disabled={busy} maxLength={3000} rows={3} placeholder="Ej. Mantén el personaje, el fondo y los textos como elementos separados" className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white outline-none focus:border-[#ff4d4d]" /></label>
                            <label className="block text-xs text-white/70">Resolución<select value={layerSize} onChange={(event) => setLayerSize(event.target.value)} disabled={busy} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white"><option value="auto">Automática</option><option value="1K">1K</option><option value="1.5K">1.5K</option><option value="2K">2K</option></select></label>
                            <button type="button" disabled={busy} onClick={() => void decomposeLayers()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}{busy ? "Separando capas…" : layerTask ? "Volver a separar desde la original" : "Separar en capas"}</button>
                            <p className="text-xs text-white/40">Necesita una conexión activa de APIMart. La salida se guarda localmente porque los enlaces del proveedor caducan.</p>
                        </> : <>
                            <div className="min-h-0 space-y-2"><div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-wider text-white/35"><span>Pila de capas</span><span>Arriba = frente</span></div><div className="max-h-[min(58dvh,560px)] space-y-1.5 overflow-y-auto overscroll-contain pr-1">{orderedLayers.slice().reverse().map((layer: ImageLayerMetadata, rowIndex) => { const visible = layer.index !== referenceIndex && layerVisibility[layer.index] !== false; const topmost = rowIndex === 0; const bottommost = rowIndex === orderedLayers.length - 1; const locked = isLockedLayer(layer.index); return <div key={layer.index} className={`flex items-center gap-1 rounded-lg border p-1.5 ${selectedLayerIndex === layer.index ? "border-[#ff4d4d]/70 bg-[#251010]" : "border-white/10"}`}><GripVertical className={`h-3.5 w-3.5 shrink-0 ${locked ? "text-white/10" : "text-white/25"}`} aria-hidden="true" /><button type="button" onClick={() => setSelectedLayerIndex(layer.index)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left"><img src={layerImages[layer.index]} alt={layer.name} className="h-8 w-8 shrink-0 bg-[#090909] object-contain" /><span className="min-w-0"><strong className="block truncate text-[11px] text-white">{layer.name}</strong><span className="block truncate text-[10px] text-white/40">{locked ? (layer.role === "reference" || layer.index === referenceIndex ? "Referencia original · bloqueada" : "Base · bloqueada") : layer.description || "Capa transparente"}</span></span></button><div className="flex shrink-0 items-center"><button type="button" aria-label={`Subir ${layer.name}`} title="Subir capa" disabled={locked || topmost || busy} onClick={() => moveLayer(layer.index, 1)} className="rounded-md p-1 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-25"><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" aria-label={`Bajar ${layer.name}`} title="Bajar capa" disabled={locked || bottommost || busy} onClick={() => moveLayer(layer.index, -1)} className="rounded-md p-1 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-25"><ArrowDown className="h-3.5 w-3.5" /></button><button type="button" aria-label={visible ? `Ocultar ${layer.name}` : `Mostrar ${layer.name}`} title={visible ? "Ocultar capa" : "Mostrar capa"} disabled={busy || layer.index === referenceIndex} onClick={() => setLayerVisibility((current) => ({ ...current, [layer.index]: !visible }))} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white">{visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button><a href={layerImages[layer.index]} download aria-label={`Descargar ${layer.name}`} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"><Download className="h-3.5 w-3.5" /></a><button type="button" aria-label={`Eliminar ${layer.name}`} title={locked ? "Capa bloqueada" : "Eliminar capa"} disabled={locked || busy} onClick={() => deleteLayer(layer.index)} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-red-300 disabled:opacity-25"><Trash2 className="h-3.5 w-3.5" /></button></div></div>; })}</div></div>
                            {selectedLayerEditable && <><label className="block rounded-xl border border-white/10 p-3 text-xs font-semibold text-white/70">Escala de la capa<input type="range" min="0.5" max="2" step="0.05" value={layerTransform(selectedLayerIndex).scale} onChange={(event) => setLayerTransforms((current) => ({ ...current, [selectedLayerIndex]: { ...layerTransform(selectedLayerIndex), scale: Number(event.target.value) } }))} disabled={busy} className="mt-3 w-full accent-[#c62828]" /><span className="mt-1 block text-right text-[11px] font-normal text-white/45">{Math.round(layerTransform(selectedLayerIndex).scale * 100)}%</span><button type="button" onClick={() => resetLayerTransform(selectedLayerIndex)} disabled={busy} className="mt-2 text-[11px] font-normal text-white/60 underline hover:text-white">Restablecer posición y escala</button></label><label className="block text-xs font-semibold text-white/70">Editar capa seleccionada<textarea value={layerEditPrompt} onChange={(event) => setLayerEditPrompt(event.target.value)} disabled={busy} maxLength={3000} rows={3} placeholder="Ej. Cambia el color de la chaqueta a rojo" className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white outline-none focus:border-[#ff4d4d]" /></label><button type="button" disabled={busy || !layerEditPrompt.trim()} onClick={() => void editLayer()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{busy ? "Editando capa…" : "Generar cambio en la capa"}</button></>}
                            <button type="button" onClick={() => void decomposeLayers()} disabled={busy} className="text-xs text-white/60 underline hover:text-white">Separar otra vez esta imagen</button>
                        </>}
                    </section> : tool === "text" ? <section className="mt-6 space-y-4">
                        <p className="text-xs leading-relaxed text-white/55">Añade títulos, llamadas y etiquetas directamente sobre la imagen. Selecciona el texto en el lienzo y arrástralo para ubicarlo.</p>
                        <button type="button" onClick={addTextLayer} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45"><Type className="h-4 w-4" />Agregar texto</button>
                        {textLayers.length > 0 && <div className="space-y-1.5"><p className="px-1 text-[10px] uppercase tracking-wider text-white/35">Capas de texto</p>{textLayers.map((item) => <div key={item.id} className={`flex items-center gap-2 rounded-lg border p-2 ${selectedTextLayerId === item.id ? "border-[#ff4d4d]/70 bg-[#251010]" : "border-white/10"}`}><button type="button" onClick={() => { setSelectedTextLayerId(item.id); setPanMode(false); }} className="min-w-0 flex-1 truncate text-left text-xs text-white">{item.text || "Texto vacío"}</button><button type="button" title={item.visible ? "Ocultar texto" : "Mostrar texto"} aria-label={item.visible ? `Ocultar ${item.text}` : `Mostrar ${item.text}`} onClick={() => updateTextLayer(item.id, { visible: !item.visible })} className="rounded-md p-1 text-white/60 hover:bg-white/10">{item.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button><button type="button" title="Eliminar texto" aria-label={`Eliminar ${item.text}`} onClick={() => removeTextLayer(item.id)} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>}
                        {selectedTextLayer && <div className="space-y-3 rounded-xl border border-white/10 p-3"><label className="block text-xs font-semibold text-white/70">Contenido<textarea value={selectedTextLayer.text} onChange={(event) => updateTextLayer(selectedTextLayer.id, { text: event.target.value.slice(0, 2000) })} rows={3} maxLength={2000} className="mt-2 w-full resize-y rounded-lg border border-white/15 bg-[#191919] p-2.5 text-sm text-white outline-none focus:border-[#ff4d4d]" /></label><label className="block text-xs font-semibold text-white/70">Fuente de Google Fonts<input list="google-font-families" value={selectedTextLayer.fontFamily} onChange={(event) => updateTextLayer(selectedTextLayer.id, { fontFamily: event.target.value })} className="mt-2 w-full rounded-lg border border-white/15 bg-[#191919] p-2.5 text-sm text-white outline-none focus:border-[#ff4d4d]" /><datalist id="google-font-families">{googleFontFamilies.map((font) => <option key={font} value={font} />)}</datalist><span className="mt-1 block text-[10px] font-normal text-white/40">Escribe cualquier familia disponible en Google Fonts para cargarla en el lienzo.</span></label><div className="grid grid-cols-2 gap-2"><label className="text-xs font-semibold text-white/70">Tamaño<input type="number" min={8} max={240} value={selectedTextLayer.fontSize} onChange={(event) => updateTextLayer(selectedTextLayer.id, { fontSize: Math.max(8, Math.min(240, Number(event.target.value) || 8)) })} className="mt-2 w-full rounded-lg border border-white/15 bg-[#191919] p-2.5 text-sm text-white" /></label><label className="text-xs font-semibold text-white/70">Peso<select value={selectedTextLayer.fontWeight} onChange={(event) => updateTextLayer(selectedTextLayer.id, { fontWeight: Number(event.target.value) })} className="mt-2 w-full rounded-lg border border-white/15 bg-[#191919] p-2.5 text-sm text-white"><option value={300}>Ligero</option><option value={400}>Regular</option><option value={500}>Medio</option><option value={600}>Seminegrita</option><option value={700}>Negrita</option><option value={800}>Extra negrita</option><option value={900}>Negro</option></select></label></div><div className="grid grid-cols-[1fr_auto] items-end gap-2"><label className="text-xs font-semibold text-white/70">Alineación<select value={selectedTextLayer.align} onChange={(event) => updateTextLayer(selectedTextLayer.id, { align: event.target.value as TextLayer["align"] })} className="mt-2 w-full rounded-lg border border-white/15 bg-[#191919] p-2.5 text-sm text-white"><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></label><label className="text-xs font-semibold text-white/70">Color<input type="color" value={selectedTextLayer.color} onChange={(event) => updateTextLayer(selectedTextLayer.id, { color: event.target.value })} className="mt-2 h-10 w-14 cursor-pointer rounded-lg border border-white/15 bg-[#191919] p-1" /></label></div><button type="button" onClick={() => removeTextLayer(selectedTextLayer.id)} className="flex items-center gap-2 text-xs text-white/60 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" />Eliminar capa de texto</button></div>}
                    </section> : tool === "expand" ? <div className="mt-6 space-y-5">
                        <p className="text-xs leading-relaxed text-white/55">Arrastra los tiradores de uno o varios bordes de la imagen. El área cuadriculada que ves en el lienzo será generada por IA; la imagen original no se recortará.</p>
                        {outpaintPlan ? <div className="rounded-xl border border-white/10 bg-[#0c0c0c] p-3 text-xs text-white/65"><p className="font-semibold text-white">Área final: {outpaintPlan.target.width} × {outpaintPlan.target.height} px</p><p className="mt-1">Izquierda {outpaintPadding.left} · Derecha {outpaintPadding.right} · Arriba {outpaintPadding.top} · Abajo {outpaintPadding.bottom} px</p><p className="mt-1 text-white/40">Formato compatible del modelo: {outpaintPlan.ratio}. El sobrante se recortará fuera del área marcada.</p></div> : <p className="rounded-xl border border-dashed border-white/15 p-3 text-xs text-white/50">Arrastra un borde para marcar el área nueva.</p>}
                        {Object.values(outpaintPadding).some(Boolean) && <button type="button" onClick={() => setOutpaintPadding({ left: 0, right: 0, top: 0, bottom: 0 })} disabled={busy} className="text-xs text-white/65 underline hover:text-white">Restablecer bordes</button>}
                        {outpaintError && <p role="alert" className="text-xs text-red-300">{outpaintError}</p>}
                        <label className="flex items-start gap-3 rounded-xl border border-white/10 p-3 text-xs text-white/70"><input type="checkbox" checked={preserveOriginal} onChange={(event) => setPreserveOriginal(event.target.checked)} disabled={busy} className="mt-0.5 accent-[#c62828]" /><span><strong className="block text-white">Conservar imagen original</strong>Fija sus píxeles sobre el resultado. Puede notarse la unión con los bordes nuevos; desactívalo para que la IA adapte toda la composición.</span></label>
                        <label className="block text-xs text-white/70">¿Qué debe aparecer en la zona nueva?<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy} maxLength={3000} rows={3} placeholder="Ej. Continúa el paisaje y el cielo hacia la derecha" className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white outline-none focus:border-[#ff4d4d]" /></label>
                        <label className="block text-xs text-white/70">Modelo de imagen<select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || !models.length} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white disabled:opacity-50">{models.length ? modelOptions : <option value="">Sin modelos compatibles</option>}</select></label>
                        {selectedModel && !selectedModel.supportsExpand && <p className="text-xs text-amber-200/80">Este modelo permite editar la imagen, pero la expansión de bordes está disponible con OpenRouter.</p>}
                        <label className="block text-xs text-white/70">Calidad<select value={quality} onChange={(event) => setQuality(event.target.value)} disabled={busy} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white"><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label>
                        <button type="button" disabled={busy || uploading || !configured || !model || !outpaintPlan || !instruction.trim()} onClick={() => void submit()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Expand className="h-4 w-4" />}{busy ? "Expandiendo imagen…" : "Generar expansión"}</button>
                        <p className="text-xs text-white/55">{outpaintPrice}</p><p className="text-xs text-white/45">Es una estimación de salida, no el coste total. La expansión usa OpenRouter; la imagen anterior no se reemplaza.</p>
                    </div> : <div className="mt-6 space-y-5">
                        {(tool === "mask" || tool === "erase") && <section className="rounded-xl border border-white/10 p-3"><p className="text-xs text-white/60">{tool === "erase" ? "Pinta el objeto a borrar. La IA reconstruirá el fondo." : "Pinta la zona que quieres modificar."}</p><div className="mt-3 flex items-center gap-3"><label htmlFor="edit-brush" className="text-xs text-white/70">Pincel</label><input id="edit-brush" type="range" min="1" max="15" value={brush} onChange={(event) => setBrush(Number(event.target.value))} className="min-w-0 flex-1 accent-[#ff4d4d]" /><button type="button" onClick={() => resetMask()} title="Limpiar zona pintada" aria-label="Limpiar zona pintada" className="rounded-lg p-2 text-white/70 hover:bg-white/10"><X className="h-4 w-4" /></button></div></section>}
                        {tool === "comments" && <section className="rounded-xl border border-white/10 p-3"><p className="text-xs text-white/60">Haz clic en hasta ocho puntos de la imagen y describe cada cambio. Se enviarán juntos.</p><div className="mt-3 space-y-3">{comments.map((item, position) => <div key={item.id} className={`rounded-lg border p-2 ${selectedComment === item.id ? "border-[#ff4d4d]/60" : "border-white/10"}`}><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">Punto {position + 1}</span><button type="button" onClick={() => setComments((current) => current.filter((comment) => comment.id !== item.id))} className="text-xs text-white/50 hover:text-red-300">Quitar</button></div><textarea value={item.text} maxLength={400} rows={2} onFocus={() => setSelectedComment(item.id)} onChange={(event) => setComments((current) => current.map((comment) => comment.id === item.id ? { ...comment, text: event.target.value } : comment))} placeholder="Ej. Cambia solo el color de este producto" className="w-full rounded-lg border border-white/15 bg-[#191919] p-2 text-xs outline-none focus:border-[#ff4d4d]" /></div>)}{!comments.length && <p className="text-xs text-white/40">Aún no hay puntos marcados.</p>}</div></section>}
                        <label htmlFor="edit-instruction" className="block text-xs font-semibold text-white/70">{tool === "comments" ? "Instrucción general (opcional)" : tool === "erase" ? "Indicaciones adicionales (opcional)" : "¿Qué quieres cambiar?"}<textarea id="edit-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy} maxLength={3000} rows={4} placeholder={tool === "erase" ? "Ej. Reconstruye la pared detrás del objeto" : "Describe el resultado que quieres obtener"} className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white outline-none focus:border-[#ff4d4d] disabled:opacity-50" /></label>
                        <div className="border-t border-white/10 pt-4"><label className="block text-xs text-white/70">Modelo de imagen<select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length || busy} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-3 text-sm text-white disabled:opacity-50">{models.length ? modelOptions : <option value="">Sin modelos compatibles</option>}</select></label><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs text-white/70">Calidad<select value={quality} onChange={(event) => setQuality(event.target.value)} disabled={busy} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-2.5 text-sm text-white"><option value="medium">Media</option><option value="high">Alta</option><option value="low">Baja</option></select></label><label className="text-xs text-white/70">Formato<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} disabled={busy} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] p-2.5 text-sm text-white"><option value="auto">Automático</option><option value="1:1">1:1</option><option value="3:2">3:2</option><option value="2:3">2:3</option></select></label></div></div>
                        {!onRequestImage && <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/15 p-3 text-xs text-white/70 hover:bg-white/5"><ImagePlus className="h-4 w-4" />{uploading ? "Subiendo…" : "Usar otra imagen desde mi equipo"}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" disabled={uploading || busy} onChange={(event) => { void uploadSource(event.target.files?.[0]); event.target.value = ""; }} /></label>}
                        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/15 p-3 text-xs text-white/70 hover:bg-white/5"><ImagePlus className="h-4 w-4" />{reference ? reference.name : "Añadir imagen de referencia"}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="sr-only" disabled={busy} onChange={(event) => setReference(event.target.files?.[0] ?? null)} /></label>{referenceUrl && <div className="flex items-center gap-2"><img src={referenceUrl} alt="Referencia" className="h-12 w-12 rounded object-cover" /><button type="button" onClick={() => setReference(null)} className="text-xs text-white/60">Quitar referencia</button></div>}
                        <button type="button" disabled={busy || uploading || !configured || !models.length} onClick={() => void submit()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121] disabled:opacity-45">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{busy ? "Procesando imagen…" : "Generar nueva versión"}</button><p className="text-xs text-white/45">La edición consume créditos del proveedor seleccionado. La original no se reemplaza.</p>
                    </div>}
                    {configured === false && tool !== "background" && <button type="button" onClick={() => void doc.save().then(saved => { if (!saved) return; if (!embedded) onClose(); window.dispatchEvent(new Event("open-higgsfield:open-connections")); })} className="mt-4 text-left text-xs text-amber-200 underline">{connectionMessage || "Conecta un proveedor de imágenes en Conexiones de APIs para editar."}</button>}
                    {renderError && <p role="alert" className="mt-3 text-xs text-amber-200">{renderError}</p>}
                    {error && <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">{error}</p>}
                    {rootPrompt && <details className="mt-6 border-t border-white/10 pt-4 text-xs text-white/60"><summary className="cursor-pointer font-semibold text-white/80">Prompt original</summary><p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{rootPrompt}</p></details>}
                </aside>
            </div>
        </div>
    </div>;
}
