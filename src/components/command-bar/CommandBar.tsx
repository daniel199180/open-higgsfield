"use client";

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Layers3, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { VIDEO_CAPABILITIES } from "@/models/capabilities/video";
import { IMAGE_CAPABILITIES } from "@/models/capabilities/image";
import { getEditVariant, getImageAspectRatios, requiresImageAspectRatio } from "@/models/capabilities/image-helpers";
import { getVideoOverrides, getDurations, getAspectRatios, hasAttachments as videoHasAttachments } from "@/models/capabilities/video-helpers";
import type { AttachmentRole } from "@/models/capabilities/video-helpers";
import type { MediaSlotCapability } from "@/models/capabilities/types";
import { hasActiveModelApi } from "@/lib/model-availability";
import { revalidateVideoTasks } from "@/hooks/useVideoTasks";
import { revalidateImageTasks } from "@/hooks/useImageTasks";
import { defaultSettings } from "@/components/studio/SettingsPanel";
import type { SettingsValues } from "@/components/studio/SettingsPanel";
import type { AttachmentItem } from "@/components/studio/AttachmentZone";
import type { SizeUiResolution } from "@/types";
import { buildGroupedDropTargets, slotsToDropDescriptors, type GroupedDropTarget } from "@/lib/attachment-drop-targets";
import { remapSlotFilesOnModelSwitch, remapVideoAttachmentsOnModelSwitch } from "@/lib/attachment-remap";

import { VideoModelPill } from "@/components/command-bar/VideoModelPill";
import { ImageModelPill } from "@/components/command-bar/ImageModelPill";
import { DurationPill } from "@/components/command-bar/DurationPill";
import { AspectRatioPill } from "@/components/command-bar/AspectRatioPill";
import { ResolutionPill } from "@/components/command-bar/ResolutionPill";
import { TogglePill } from "@/components/command-bar/TogglePill";
import { ControlsPill } from "@/components/command-bar/ControlsPill";
import { VideoControlsPill } from "@/components/command-bar/VideoControlsPill";
import { AttachmentButton } from "@/components/command-bar/AttachmentButton";
import { ImageAttachmentButton } from "@/components/command-bar/ImageAttachmentButton";
import { GenerationPrice } from "@/components/studio/GenerationPrice";
import { DesignSystemPill } from "@/components/command-bar/DesignSystemPill";
import { CharacterPill } from "@/components/command-bar/CharacterPill";
import { CompanySelect, useCompanySelection } from "@/components/command-bar/CompanySelect";
import type { Character } from "@/social/types";
import type { BrandSystem } from "@/social/types";
import type { SocialProject } from "@/social/types";
import { brandLogoAssetIds, brandImageAssetIds, brandTypographyPrompt } from "@/social/brand";
import { PillPopover } from "@/components/command-bar/PillPopover";
import { StudioModePill, type StudioMode } from "@/components/studio/StudioModePill";
import { LogoComposer } from "@/components/command-bar/LogoComposer";

const schema = z.object({ prompt: z.string().max(2000) });
type FormData = z.infer<typeof schema>;

async function waitForImageResult(taskId: string, onProgress: (message: string) => void): Promise<Blob> {
    const maxAttempts = 150;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await fetch("/api/image-tasks", { cache: "no-store" });
        if (!response.ok) throw new Error("No se pudo consultar el resultado base.");
        const tasks = await response.json() as Array<{ task_id: string; status?: string; _done?: boolean; result_urls?: string[]; error_message?: string }>;
        const task = tasks.find(item => item.task_id === taskId);
        if (task?._done || ["COMPLETED", "FAILED", "ERROR", "CANCELLED"].includes(task?.status ?? "")) {
            if (task.status !== "COMPLETED" || !task.result_urls?.[0]) throw new Error(task.error_message || "La imagen base no se pudo generar; no se crearán las variantes.");
            const imageResponse = await fetch(`/api/download/${encodeURIComponent(taskId)}?index=0`, { cache: "no-store" });
            if (!imageResponse.ok) throw new Error("No se pudo leer la imagen base para adaptar los formatos.");
            return imageResponse.blob();
        }
        onProgress(`Esperando la imagen principal (${Math.min(attempt + 1, maxAttempts)}/${maxAttempts})…`);
        await new Promise(resolve => window.setTimeout(resolve, 2000));
    }
    throw new Error("La imagen principal sigue procesándose. Revisa la galería; puedes volver a intentar las variantes cuando termine.");
}

interface CommandBarProps {
    mode: StudioMode;
    onModeChange: (mode: StudioMode) => void;
}

export function CommandBar({ mode, onModeChange }: CommandBarProps) {
    return mode === "logo" ? <LogoComposer onModeChange={onModeChange} /> : mode === "audio" ? null : <MediaCommandBar mode={mode} onModeChange={onModeChange} />;
}

function MediaCommandBar({ mode, onModeChange }: CommandBarProps & { mode: "video" | "image" | "carousel" }) {
    const locale = useLocale();
    const t = useTranslations("studio");
    const tErrors = useTranslations("errors");
    const tCommon = useTranslations("common");
    const tCommand = useTranslations("commandBar");

    // ── Video state ──
    const firstVideoId = Object.keys(VIDEO_CAPABILITIES)[0];
    const [videoModelId, setVideoModelId] = useState(firstVideoId);
    const [videoVariantId, setVideoVariantId] = useState("");
    const [videoSettings, setVideoSettings] = useState<SettingsValues>(
        defaultSettings(VIDEO_CAPABILITIES[firstVideoId])
    );
    const [attachments, setAttachments] = useState<AttachmentItem[]>([]);

    // ── Image state ──
    const firstImageId = Object.keys(IMAGE_CAPABILITIES)[0];
    const [imageModelId, setImageModelId] = useState(firstImageId);
    // Never silently pick a provider default (many default to 16:9). The user chooses the canvas.
    const [selectedImageFormats, setSelectedImageFormats] = useState<string[]>([]);
    const [carouselSlideCount, setCarouselSlideCount] = useState(5);
    const [carouselCountOpen, setCarouselCountOpen] = useState(false);
    const [sizeResolution, setSizeResolution] = useState(() => {
        const m = IMAGE_CAPABILITIES[firstImageId];
        if (m?.size_ui) return m.size_ui.default_resolution ?? "";
        const resField = m?.custom_fields?.find((f) => f.id === "resolution" && f.type === "select");
        return resField?.default ? String(resField.default) : (resField?.options?.[0] ?? "");
    });
    const [imageFieldValues, setImageFieldValues] = useState<Record<string, unknown>>({});
    const [slotFiles, setSlotFiles] = useState<Record<string, File[]>>({});
    const [brands, setBrands] = useState<BrandSystem[]>([]);
    const [selectedBrandId, setSelectedBrandId] = useState("");
    const [brandsLoading, setBrandsLoading] = useState(true);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [selectedCharacterId, setSelectedCharacterId] = useState("");
    const companySelection = useCompanySelection();

    const loadCharacters = useCallback(async () => {
        try {
            const response = await fetch("/api/characters", { cache: "no-store" });
            if (!response.ok) return;
            const data = await response.json() as { characters?: Character[] };
            setCharacters(data.characters ?? []);
            setSelectedCharacterId(current => (data.characters ?? []).some(item => item.id === current) ? current : "");
        } catch { /* Character selection is optional. */ }
    }, []);
    useEffect(() => {
        void loadCharacters();
        window.addEventListener("open-higgsfield:characters-updated", loadCharacters);
        return () => window.removeEventListener("open-higgsfield:characters-updated", loadCharacters);
    }, [loadCharacters]);

    useEffect(() => {
        if (mode === "carousel") setSelectedImageFormats(current => current.slice(0, 1));
    }, [mode]);

    // ── Shared state ──
    const [apiError, setApiError] = useState<string | null>(null);
    const [apiErrorDetail, setApiErrorDetail] = useState<string | null>(null);
    const [pendingGeneration, setPendingGeneration] = useState<{ model: string; startedAt: number; progress?: string } | null>(null);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    // State alone does not block two submissions in the same render cycle.
    const submissionInFlight = useRef(false);
    const isGenerating = pendingGeneration !== null;
    const [isDragOverlayVisible, setIsDragOverlayVisible] = useState(false);
    const [activeDropTargetId, setActiveDropTargetId] = useState<string | null>(null);

    const { control, setValue, handleSubmit } = useForm<FormData>({
        resolver: zodResolver(schema),
        defaultValues: { prompt: "" },
    });
    const prompt = useWatch({ control, name: "prompt" }) ?? "";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const dragDepthRef = useRef(0);

    const loadBrands = useCallback(async () => {
        try {
            const response = await fetch("/api/social", { cache: "no-store" });
            if (!response.ok) return;
            const data = await response.json() as { brands?: BrandSystem[] };
            const nextBrands = Array.isArray(data.brands) ? data.brands : [];
            setBrands(nextBrands);
            setSelectedBrandId((current) => {
                const remembered = current || window.localStorage.getItem("open-higgsfield:selected-brand") || "";
                return nextBrands.some((brand) => brand.id === remembered) ? remembered : "";
            });
        } catch {
            // Social design systems are optional; generation remains available without one.
        } finally {
            setBrandsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadBrands();
        window.addEventListener("open-higgsfield:social-brands-updated", loadBrands);
        return () => window.removeEventListener("open-higgsfield:social-brands-updated", loadBrands);
    }, [loadBrands]);

    const selectBrand = useCallback((id: string) => {
        setSelectedBrandId(id);
        if (id) window.localStorage.setItem("open-higgsfield:selected-brand", id);
        else window.localStorage.removeItem("open-higgsfield:selected-brand");
    }, []);

    useEffect(() => {
        if (!pendingGeneration) return;
        const timer = window.setInterval(() => {
            setElapsedSeconds(Math.floor((Date.now() - pendingGeneration.startedAt) / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [pendingGeneration]);

    const autoResize = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, []);

    useEffect(() => {
        const applySavedPrompt = (event: Event) => {
            const value = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
            if (!value) return;
            setValue("prompt", value);
            window.setTimeout(autoResize, 0);
        };
        window.addEventListener("open-higgsfield:prompt-selected", applySavedPrompt);
        return () => window.removeEventListener("open-higgsfield:prompt-selected", applySavedPrompt);
    }, [autoResize, setValue]);

    // ── Models ──
    const videoModel = VIDEO_CAPABILITIES[videoModelId] ?? VIDEO_CAPABILITIES[firstVideoId];
    const videoOverrides = getVideoOverrides(videoModelId);
    const imageModel = IMAGE_CAPABILITIES[imageModelId] ?? IMAGE_CAPABILITIES[firstImageId];
    const imageEditVariant = getEditVariant(imageModel);
    const hasSelectedActiveApi = hasActiveModelApi(mode === "video" ? videoModel : imageModel);

    const imageUploadSlots = useMemo<MediaSlotCapability[]>(() => {
        const editSlots = (imageEditVariant?.slots ?? []).map((slot) => ({ ...slot, required: false }));
        return [...imageModel.media_slots, ...editSlots];
    }, [imageModel, imageEditVariant]);

    const videoRoleDescriptors = useMemo(() => {
        const overrideRoles = videoOverrides.attachment_roles;
        if (overrideRoles && overrideRoles.length > 0) {
            return overrideRoles.map((role: AttachmentRole) => ({
                id: role.id,
                label: role.label,
                kind: role.kind,
                required: role.required,
                multiple: false,
            }));
        }

        return videoModel.media_slots.map((slot) => ({
            id: slot.id,
            label: slot.label,
            kind: slot.kind,
            required: slot.required,
            multiple: slot.multiple,
        }));
    }, [videoModel, videoOverrides]);

    const dropTargets = useMemo(() => {
        if (mode !== "video") {
            return buildGroupedDropTargets(slotsToDropDescriptors(imageUploadSlots));
        }
        return buildGroupedDropTargets(videoRoleDescriptors);
    }, [mode, imageUploadSlots, videoRoleDescriptors]);

    const hasDropTargets = dropTargets.length > 0;

    useEffect(() => {
        const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

        const handleDragEnter = (event: DragEvent) => {
            if (!hasFiles(event) || !hasDropTargets) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setIsDragOverlayVisible(true);
        };

        const handleDragOver = (event: DragEvent) => {
            if (!hasFiles(event) || !hasDropTargets) return;
            event.preventDefault();
            if (!isDragOverlayVisible) setIsDragOverlayVisible(true);
        };

        const handleDragLeave = (event: DragEvent) => {
            if (!hasFiles(event) || !hasDropTargets) return;
            event.preventDefault();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
                setIsDragOverlayVisible(false);
                setActiveDropTargetId(null);
            }
        };

        const handleDrop = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current = 0;
            setIsDragOverlayVisible(false);
            setActiveDropTargetId(null);
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);

        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
        };
    }, [hasDropTargets, isDragOverlayVisible]);

    function fileToAttachment(roleId: string, file: File, kind: "image" | "video" | "audio"): AttachmentItem {
        return {
            id: `${roleId}-${file.name}-${file.size}-${file.lastModified}`,
            roleId,
            type: "file",
            file,
            previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
            kind,
        };
    }

    function applyImageDrop(target: GroupedDropTarget, files: File[]) {
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
        if (imageFiles.length === 0) return;

        setSlotFiles((prev) => {
            const next = { ...prev };

            if (target.roleIds.length > 1) {
                // Find empty slots first, then fill occupied ones
                const emptySlotIds = target.roleIds.filter((id) => !next[id]?.length);
                const occupiedSlotIds = target.roleIds.filter((id) => next[id]?.length);
                const orderedSlotIds = [...emptySlotIds, ...occupiedSlotIds];

                imageFiles.forEach((file, index) => {
                    const slotId = orderedSlotIds[index];
                    if (!slotId) return;
                    next[slotId] = [file];
                });
                return next;
            }

            const slotId = target.roleIds[0];
            if (target.acceptMany) {
                next[slotId] = [...(next[slotId] ?? []), ...imageFiles];
            } else {
                next[slotId] = [imageFiles[0]];
            }

            return next;
        });
    }

    function applyVideoDrop(target: GroupedDropTarget, files: File[]) {
        const acceptedFiles = files.filter((file) => file.type.startsWith(`${target.kind}/`));
        if (acceptedFiles.length === 0) return;

        setAttachments((prev) => {
            const withoutTargetRoles = prev.filter((item) => !target.roleIds.includes(item.roleId));

            if (target.roleIds.length > 1) {
                const distributed = target.roleIds
                    .map((roleId, index) => {
                        const file = acceptedFiles[index];
                        if (!file) return null;
                        return fileToAttachment(roleId, file, target.kind);
                    })
                    .filter((item): item is AttachmentItem => Boolean(item));
                return [...withoutTargetRoles, ...distributed];
            }

            const roleId = target.roleIds[0];
            const dropped = target.acceptMany
                ? acceptedFiles.map((file) => fileToAttachment(roleId, file, target.kind))
                : [fileToAttachment(roleId, acceptedFiles[0], target.kind)];

            return [...withoutTargetRoles, ...dropped];
        });
    }

    function handleDropToTarget(target: GroupedDropTarget, event: React.DragEvent<HTMLElement>) {
        event.preventDefault();
        event.stopPropagation();
        setActiveDropTargetId(null);
        setIsDragOverlayVisible(false);
        dragDepthRef.current = 0;

        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length === 0) return;

        if (mode !== "video") {
            applyImageDrop(target, files);
            return;
        }

        applyVideoDrop(target, files);
    }

    // ── Handlers ──
    const handleVideoModelChange = useCallback((id: string, varId: string) => {
        const previousModel = VIDEO_CAPABILITIES[videoModelId] ?? VIDEO_CAPABILITIES[firstVideoId];
        const previousOverrides = getVideoOverrides(previousModel.id);
        const previousRoles =
            previousOverrides.attachment_roles?.map((role) => ({
                id: role.id,
                label: role.label,
                kind: role.kind,
                multiple: false,
            }))
            ?? previousModel.media_slots.map((slot) => ({
                id: slot.id,
                label: slot.label,
                kind: slot.kind,
                multiple: slot.multiple,
            }));

        const nextModel = VIDEO_CAPABILITIES[id] ?? VIDEO_CAPABILITIES[firstVideoId];
        const nextOverrides = getVideoOverrides(nextModel.id);
        const nextRoles =
            nextOverrides.attachment_roles?.map((role) => ({
                id: role.id,
                label: role.label,
                kind: role.kind,
                multiple: false,
            }))
            ?? nextModel.media_slots.map((slot) => ({
                id: slot.id,
                label: slot.label,
                kind: slot.kind,
                multiple: slot.multiple,
            }));

        setAttachments((current) => remapVideoAttachmentsOnModelSwitch(current, previousRoles, nextRoles));
        setVideoModelId(id);
        setVideoVariantId(varId);
        setVideoSettings(defaultSettings(VIDEO_CAPABILITIES[id], varId));
    }, [videoModelId, firstVideoId]);

    const handleImageModelChange = useCallback((id: string) => {
        const previousModel = IMAGE_CAPABILITIES[imageModelId] ?? IMAGE_CAPABILITIES[firstImageId];
        const previousEditVariant = getEditVariant(previousModel);
        const previousSlots: MediaSlotCapability[] = [
            ...previousModel.media_slots,
            ...((previousEditVariant?.slots ?? []).map((slot) => ({ ...slot, required: false }))),
        ];

        const nextModel = IMAGE_CAPABILITIES[id] ?? IMAGE_CAPABILITIES[firstImageId];
        const nextEditVariant = getEditVariant(nextModel);
        const nextSlots: MediaSlotCapability[] = [
            ...nextModel.media_slots,
            ...((nextEditVariant?.slots ?? []).map((slot) => ({ ...slot, required: false }))),
        ];

        setSlotFiles((current) => remapSlotFilesOnModelSwitch(current, previousSlots, nextSlots));

        setImageModelId(id);
        // An error from the previous model must not survive a capability change.
        setApiError(null);
        setApiErrorDetail(null);
        const aspectOptions = getImageAspectRatios(nextModel).map(([value]) => value);
        setSelectedImageFormats((current) => {
            const supported = current.filter((ratio) => aspectOptions.includes(ratio));
            if (supported.length) return nextSlots.some((slot) => slot.kind === "image") ? supported : supported.slice(0, 1);

            // A newly selected provider model must never inherit an empty
            // format. Dynamic catalogs expose their default on aspect_ratio.
            const configuredDefault = nextModel.size_ui?.default_aspect
                ?? (nextModel.aspect_ratio !== false ? nextModel.aspect_ratio.default?.[1] : undefined);
            const defaultAspect = configuredDefault && aspectOptions.includes(configuredDefault)
                ? configuredDefault
                : aspectOptions[0];
            return defaultAspect ? [defaultAspect] : [];
        });
        // Preserve field values for fields that exist in both old and new model (same id + type)
        setImageFieldValues((prev) => {
            const prevModel = IMAGE_CAPABILITIES[imageModelId] ?? IMAGE_CAPABILITIES[firstImageId];
            const prevFields = prevModel.custom_fields ?? [];
            const nextFields = nextModel.custom_fields ?? [];
            const preserved: Record<string, unknown> = {};
            for (const nf of nextFields) {
                const pf = prevFields.find((f) => f.id === nf.id && f.type === nf.type);
                if (pf && prev[nf.id] !== undefined) {
                    // For select fields, only keep if value is a valid option in the new model
                    if (nf.type === "select" && nf.options) {
                        if (nf.options.includes(String(prev[nf.id]))) {
                            preserved[nf.id] = prev[nf.id];
                        }
                    } else {
                        preserved[nf.id] = prev[nf.id];
                    }
                }
            }
            return preserved;
        });
        const m = nextModel;
        if (m?.size_ui) {
            // Keep current resolution if supported
            const supportedRes = m.size_ui.resolutions.map((r) => r.id);
            if (!supportedRes.includes(sizeResolution)) {
                setSizeResolution(m.size_ui.default_resolution ?? "");
            }
        } else {
            const resField = m?.custom_fields?.find((f) => f.id === "resolution" && f.type === "select");
            if (resField?.options) {
                if (!resField.options.includes(sizeResolution)) {
                    setSizeResolution(resField.default ? String(resField.default) : (resField.options[0] ?? ""));
                }
            } else {
                setSizeResolution("");
            }
        }
    }, [imageModelId, firstImageId, sizeResolution]);

    const activeImageModelIds = Object.values(IMAGE_CAPABILITIES).filter(hasActiveModelApi).map((candidate) => candidate.id).join("|");
    const activeVideoModelIds = Object.values(VIDEO_CAPABILITIES).filter(hasActiveModelApi).map((candidate) => candidate.id).join("|");

    useEffect(() => {
        const firstActive = Object.values(IMAGE_CAPABILITIES).find(hasActiveModelApi);
        if (firstActive && !hasActiveModelApi(IMAGE_CAPABILITIES[imageModelId])) handleImageModelChange(firstActive.id);
    }, [activeImageModelIds, handleImageModelChange, imageModelId]);

    useEffect(() => {
        const firstActive = Object.values(VIDEO_CAPABILITIES).find(hasActiveModelApi);
        if (firstActive && !hasActiveModelApi(VIDEO_CAPABILITIES[videoModelId])) handleVideoModelChange(firstActive.id, "");
    }, [activeVideoModelIds, handleVideoModelChange, videoModelId]);

    useEffect(() => {
        if (mode !== "carousel") return;
        const current = IMAGE_CAPABILITIES[imageModelId];
        if (current && !current.media_slots.some(slot => slot.required) && getImageAspectRatios(current).length) return;
        const fallback = Object.values(IMAGE_CAPABILITIES).find(model => hasActiveModelApi(model) && !model.media_slots.some(slot => slot.required) && getImageAspectRatios(model).length);
        if (fallback) handleImageModelChange(fallback.id);
    }, [mode, imageModelId, handleImageModelChange]);

    // Count extra controls for image mode
    const imageControlCount = (imageModel.custom_fields ?? []).filter(
        (f) => !(f.type === "checkbox" && f.id.includes("prompt"))
            && !(f.id.toLowerCase().includes("width") || f.id.toLowerCase().includes("height"))
            && f.id !== "aspect_ratio"
            && f.id !== "resolution"
    ).length;

    // Custom dimension fields for AspectRatioPill
    const widthField = imageModel.custom_fields?.find(f => f.id.toLowerCase().includes("width"));
    const heightField = imageModel.custom_fields?.find(f => f.id.toLowerCase().includes("height"));
    const imageCustomFields = (widthField && heightField) ? {
        widthId: widthField.id,
        heightId: heightField.id,
        widthLabel: widthField.label,
        heightLabel: heightField.label,
        defaultWidth: Number(widthField.default) || 1024,
        defaultHeight: Number(heightField.default) || 768,
    } : null;

    // Unified aspect ratios
    const imageRatios = getImageAspectRatios(imageModel);
    const sizeAspect = selectedImageFormats[0] ?? "";
    const selectedExtraFormatCount = Math.max(0, selectedImageFormats.length - 1);

    // Unified resolutions
    const imageResolutions: SizeUiResolution[] = imageModel.size_ui
        ? imageModel.size_ui.resolutions
        : (() => {
            const resField = imageModel.custom_fields?.find((f) => f.id === "resolution" && f.type === "select");
            return resField?.options?.map((opt) => ({ id: opt, base: 0 })) ?? [];
        })();

    const runCarousel = async (project: SocialProject) => {
        if (!project.slides?.length) throw new Error("El carrusel no tiene páginas.");
        const model = IMAGE_CAPABILITIES[project.modelId];
        if (!model) throw new Error("El modelo del carrusel ya no está disponible.");
        const referenceSlot = model.media_slots.find(slot => slot.kind === "image" && !slot.required)
            ?? getEditVariant(model)?.slots.find(slot => slot.kind === "image");
        const tasksResponse = await fetch("/api/image-tasks", { cache: "no-store" });
        if (!tasksResponse.ok) throw new Error("No se pudo revisar el estado de las páginas.");
        const existingTasks = await tasksResponse.json() as Array<{ task_id: string; status?: string }>;
        const taskById = new Map(existingTasks.map(task => [task.task_id, task]));
        const cover = project.slides[0];
        let coverTaskId = cover.taskIds.at(-1);
        let submitted = 0;

        const submitSlide = async (slide: typeof cover, index: number, reference?: Blob) => {
            setPendingGeneration(current => current ? { ...current, progress: `Enviando página ${index + 1} de ${project.slides!.length}…` } : current);
            const form = new FormData();
            form.append("prompt", project.brief);
            form.append("model_id", project.modelId);
            form.append("size_aspect", project.aspectRatio ?? "");
            form.append("size_resolution", project.resolution ?? "");
            form.append("social_project_id", project.id);
            form.append("social_slide_id", slide.id);
            const values = project.modelId === imageModelId ? { ...imageFieldValues } : {};
            if (model.custom_fields?.some(field => field.id === "n")) values.n = 1;
            form.append("field_values", JSON.stringify(values));
            if (reference && referenceSlot) {
                form.append(`slot_${referenceSlot.id}`, reference, "carousel-cover.png");
            } else if (index === 0 && project.modelId === imageModelId) {
                for (const [slotId, files] of Object.entries(slotFiles)) files.forEach(file => form.append(`slot_${slotId}`, file));
            }
            const response = await fetch("/api/generate-image", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: form });
            const result = await response.json().catch(() => ({})) as { task_id?: string; error?: string };
            if (!response.ok || !result.task_id) throw new Error(`Página ${index + 1}: ${result.error || "no se pudo generar"}`);
            submitted += 1;
            await revalidateImageTasks();
            window.dispatchEvent(new Event("open-higgsfield:carousel-updated"));
            return result.task_id;
        };

        try {
            if (!coverTaskId || ["FAILED", "ERROR", "CANCELLED"].includes(taskById.get(coverTaskId)?.status ?? "")) {
                const source = cover.sourceTaskId && referenceSlot ? await waitForImageResult(cover.sourceTaskId, progress => setPendingGeneration(current => current ? { ...current, progress } : current)) : undefined;
                coverTaskId = await submitSlide(cover, 0, source);
            }
            const remaining = project.slides.slice(1).filter(slide => {
                const last = slide.taskIds.at(-1);
                return !last || ["FAILED", "ERROR", "CANCELLED"].includes(taskById.get(last)?.status ?? "");
            });
            let coverReference: Blob | undefined;
            if (remaining.length > 0 && referenceSlot && coverTaskId && remaining.some(slide => !slide.sourceTaskId)) {
                coverReference = await waitForImageResult(coverTaskId, progress => setPendingGeneration(current => current ? { ...current, progress } : current));
            }
            for (const slide of remaining) {
                const reference = slide.sourceTaskId && referenceSlot
                    ? await waitForImageResult(slide.sourceTaskId, progress => setPendingGeneration(current => current ? { ...current, progress } : current))
                    : coverReference;
                await submitSlide(slide, project.slides.findIndex(item => item.id === slide.id), reference);
            }
        } catch (cause) {
            const detail = cause instanceof Error ? cause.message : "No se pudo continuar.";
            throw new Error(`${submitted} página(s) nuevas enviadas. ${detail} Usa «Continuar pendientes» para reanudar sin duplicar las ya enviadas.`);
        }
    };

    useEffect(() => {
        const resume = async (event: Event) => {
            if (submissionInFlight.current) return;
            const projectId = (event as CustomEvent<{ projectId: string }>).detail?.projectId;
            if (!projectId) return;
            submissionInFlight.current = true;
            setApiError(null);
            setPendingGeneration({ model: "Carrusel", startedAt: Date.now(), progress: "Revisando páginas pendientes…" });
            try {
                const response = await fetch("/api/social", { cache: "no-store" });
                if (!response.ok) throw new Error("No se pudo cargar el carrusel.");
                const data = await response.json() as { projects?: SocialProject[] };
                const project = data.projects?.find(item => item.id === projectId && item.format === "carousel");
                if (!project) throw new Error("No se encontró el carrusel.");
                await runCarousel(project);
            } catch (cause) {
                setApiErrorDetail(cause instanceof Error ? cause.message : "No se pudo continuar.");
                setApiError("ERR_GENERIC");
            } finally {
                submissionInFlight.current = false;
                setPendingGeneration(null);
                window.dispatchEvent(new Event("open-higgsfield:carousel-updated"));
            }
        };
        window.addEventListener("open-higgsfield:carousel-resume", resume);
        return () => window.removeEventListener("open-higgsfield:carousel-resume", resume);
    });

    const onSubmit = async (data: FormData) => {
        if (submissionInFlight.current) return;
        if (!hasSelectedActiveApi) {
            setApiErrorDetail(`Conecta y activa una API compatible antes de generar ${mode === "video" ? "vídeo" : "imágenes"}.`);
            setApiError("ERR_GENERIC");
            return;
        }
        // Some catalogued image models deliberately expose no aspect-ratio
        // parameter. They must use the provider's own default instead of being
        // blocked by a client-side requirement that cannot be fulfilled.
        if (mode !== "video" && requiresImageAspectRatio(imageModel) && !sizeAspect) {
            setApiErrorDetail(null);
            setApiError("ERR_IMAGE_ASPECT_RATIO_REQUIRED");
            return;
        }
        submissionInFlight.current = true;
        setApiError(null);
        setApiErrorDetail(null);
        setElapsedSeconds(0);
        setPendingGeneration({ model: mode === "video" ? videoModel.label : imageModel.label, startedAt: Date.now(), progress: "Preparando solicitud…" });
        let submittedImages = 0;
        try {
            const selectedBrand = brands.find((brand) => brand.id === selectedBrandId);
            const selectedCharacter = characters.find((character) => character.id === selectedCharacterId);
            if (selectedCharacter && mode !== "video" && !imageUploadSlots.some(slot => slot.kind === "image")) {
                throw new Error("El modelo elegido no admite las referencias del personaje. Selecciona otro modelo de imagen.");
            }
            if (mode === "video" && selectedCharacter && selectedBrand && brandLogoAssetIds(selectedBrand).length > 0) {
                throw new Error("Este modelo de video no puede recibir a la vez todas las fotos del personaje y los logos de marca. Genera primero una imagen con ambos y úsala como fotograma inicial.");
            }
            const brandPrompt = selectedBrand ? [
                `Identidad visual de marca: ${selectedBrand.name}.`,
                `Colores: principal ${selectedBrand.primaryColor}; secundario ${selectedBrand.secondaryColor}; acento ${selectedBrand.accentColor}.`,
                brandTypographyPrompt(selectedBrand),
                selectedBrand.voice ? `Tono: ${selectedBrand.voice}.` : "",
                selectedBrand.visualRules ? `Reglas visuales: ${selectedBrand.visualRules}.` : "",
                selectedBrand.negativePrompt ? `Prohibiciones de marca: ${selectedBrand.negativePrompt}` : "",
                "Respeta esta identidad de forma coherente. Conserva el idioma y el texto solicitado en el prompt.",
            ].filter(Boolean).join("\n") : "";
            const finalPrompt = [data.prompt, brandPrompt].filter(Boolean).join("\n\n");
            const promptMax = mode === "video" ? (videoModel.prompt_max ?? 2500) : (imageModel.prompt_max ?? 10000);
            if ((mode === "video" ? finalPrompt : data.prompt).length > promptMax) {
                setApiError("ERR_PROMPT_TOO_LONG");
                return;
            }
            if (mode !== "video" && selectedBrand && brandImageAssetIds(selectedBrand).length > 0 && !imageUploadSlots.some(slot => slot.kind === "image")) {
                throw new Error("El modelo elegido no admite imágenes de referencia. Elige uno que admita los logos del sistema de diseño.");
            }
            if (mode === "carousel") {
                const brief = data.prompt.trim();
                if (brief.length < 5) throw new Error("Describe la idea del carrusel con al menos cinco caracteres.");
                if (!selectedBrand) throw new Error("Selecciona un sistema de diseño para mantener la identidad de todas las páginas.");
                if (imageModel.media_slots.some(slot => slot.required)) throw new Error("Este modelo necesita una imagen inicial obligatoria. Elige otro modelo de imagen para el carrusel.");
                const response = await fetch("/api/social/carousels", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "create", name: brief.split(/[.!?\n]/)[0].slice(0, 100) || "Nuevo carrusel", brief, brandId: selectedBrand.id, companyId: companySelection.selectedId || undefined, characterId: selectedCharacter?.id, modelId: imageModelId, aspectRatio: sizeAspect, resolution: sizeResolution, slideCount: carouselSlideCount, language: locale.startsWith("pt") ? "Português (Brasil)" : locale.startsWith("en") ? "English" : "Español", autoStory: true }),
                });
                const result = await response.json().catch(() => ({})) as { project?: SocialProject; error?: string };
                if (!response.ok || !result.project) throw new Error(result.error || "No se pudo crear el carrusel.");
                const url = new URL(window.location.href); url.searchParams.set("carousel", result.project.id); window.history.replaceState(null, "", url);
                window.dispatchEvent(new Event("open-higgsfield:carousel-updated"));
                setValue("prompt", "");
                await runCarousel(result.project);
            } else if (mode === "video") {
                const body = new FormData();
                body.append("prompt", finalPrompt);
                body.append("model_id", videoModelId);
                if (companySelection.selectedId) body.append("company_id", companySelection.selectedId);
                body.append("variant_id", videoVariantId);
                body.append("settings", JSON.stringify(videoSettings));
                if (selectedCharacter) body.append("character_id", selectedCharacter.id);
                for (const att of attachments) {
                    if (att.file) body.append(`file_${att.roleId}`, att.file);
                    else if (att.url) body.append(`url_${att.roleId}`, att.url);
                }
                if (selectedBrand?.logoAssetId && !selectedCharacter) {
                    const logoRole = videoRoleDescriptors.find((role) => role.kind === "image" && !attachments.some((item) => item.roleId === role.id));
                    if (logoRole) {
                        const logoResponse = await fetch(`/api/workflows/assets/${selectedBrand.logoAssetId}`, { cache: "no-store" });
                        if (!logoResponse.ok) throw new Error("No se pudo cargar el logo del sistema de diseño.");
                        body.append(`file_${logoRole.id}`, await logoResponse.blob(), "brand-logo.png");
                    }
                }
                const res = await fetch("/api/generate", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body });
                if (!res.ok) {
                    const json = await res.json().catch(() => ({}));
                    setApiError(json.error ?? "ERR_GENERIC");
                }
                await revalidateVideoTasks();
            } else {
                const variants = selectedImageFormats.slice(1)
                    .map((ratio) => [ratio, imageRatios.find(([value]) => value === ratio)?.[1] ?? ratio] as const);
                const hasVariants = variants.length > 0;
                const referenceSlot = imageUploadSlots.find(slot => slot.kind === "image");
                if (hasVariants && !referenceSlot) {
                    setApiErrorDetail("Para adaptar un mismo post a varios formatos, selecciona un modelo que admita imágenes de referencia.");
                    setApiError("ERR_GENERIC");
                    return;
                }

                const ratioField = imageModel.custom_fields?.find(field => field.id === "aspect_ratio" && field.type === "select");
                const baseFieldValues = { ...imageFieldValues };
                if (hasVariants && imageModel.custom_fields?.some(field => field.id === "n")) baseFieldValues.n = 1;
                const makeVariantPrompt = (label: string) => [
                    data.prompt,
                    `ADAPTACIÓN DEL MISMO POST A ${label}. La imagen adjunta es la pieza original y debe ser tu referencia visual principal. Conserva exactamente el mismo tema, mensaje, elementos, producto/personas, identidad de marca, estilo y texto visible; no inventes una publicación distinta ni cambies las palabras. Recompón el diseño para el nuevo lienzo: expande o reconstruye el fondo, recoloca y escala los elementos, preserva márgenes seguros y evita cortar el logo, los sujetos o cualquier texto. No estires la imagen original.`,
                ].join("\n\n");

                if (hasVariants && variants.some(([, label]) => makeVariantPrompt(label).length > promptMax)) {
                    setApiError("ERR_PROMPT_TOO_LONG");
                    return;
                }

                const submitImage = async (ratio: string, promptText: string, reference?: Blob) => {
                    const body = new FormData();
                    const fieldValues = { ...baseFieldValues };
                    if (ratioField?.options?.includes(ratio)) fieldValues[ratioField.id] = ratio;
                    body.append("prompt", promptText);
                    body.append("model_id", imageModelId);
                    if (companySelection.selectedId) body.append("company_id", companySelection.selectedId);
                    if (selectedBrand) body.append("brand_id", selectedBrand.id);
                    if (selectedCharacter) body.append("character_id", selectedCharacter.id);
                    body.append("size_aspect", ratio);
                    body.append("size_resolution", sizeResolution);
                    body.append("field_values", JSON.stringify(fieldValues));
                    for (const [slotId, files] of Object.entries(slotFiles)) {
                        if (reference && slotId === referenceSlot?.id) continue;
                        files.forEach(file => body.append(`slot_${slotId}`, file));
                    }
                    if (reference && referenceSlot) {
                        body.append(`slot_${referenceSlot.id}`, reference, "original-post-reference.png");
                    }
                    const response = await fetch("/api/generate-image", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body });
                    const result = await response.json().catch(() => ({})) as { task_id?: string; error?: string };
                    if (!response.ok || !result.task_id) throw new Error(result.error ?? "No se pudo enviar la generación.");
                    submittedImages += 1;
                    await revalidateImageTasks();
                    return result.task_id;
                };

                setPendingGeneration(current => current ? { ...current, progress: hasVariants ? `Generando imagen principal para ${variants.length + 1} formatos…` : "Generando imagen…" } : current);
                const baseTaskId = await submitImage(sizeAspect, data.prompt);
                if (hasVariants && referenceSlot) {
                    const reference = await waitForImageResult(baseTaskId, progress => setPendingGeneration(current => current ? { ...current, progress } : current));
                    for (const [index, [ratio, label]] of variants.entries()) {
                        setPendingGeneration(current => current ? { ...current, progress: `Adaptando formato ${label} (${index + 1}/${variants.length})…` } : current);
                        await submitImage(ratio, makeVariantPrompt(label), reference);
                    }
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (mode === "image" && submittedImages > 0 && submittedImages < selectedImageFormats.length) {
                const translated = /^ERR_[A-Z0-9_]+$/.test(message) && tErrors.has(message as never)
                    ? tErrors(message as never) : message;
                setApiErrorDetail(`Se enviaron ${submittedImages} de ${selectedImageFormats.length} formatos. Faltan ${selectedImageFormats.length - submittedImages}. ${translated || "Revisa el historial antes de volver a generar."}`);
                setApiError("ERR_GENERIC");
            } else if (/^ERR_[A-Z0-9_]+$/.test(message)) {
                setApiErrorDetail(null);
                setApiError(message);
            } else {
                setApiErrorDetail(message || null);
                setApiError("ERR_GENERATION_CONNECTION_INTERRUPTED");
            }
        } finally {
            submissionInFlight.current = false;
            setPendingGeneration(null);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!submissionInFlight.current) void handleSubmit(onSubmit)();
        }
    };

    return (
        <div className="fixed left-0 right-0 bottom-0 z-20 pointer-events-none" style={{ padding: "16px 20px 20px" }}>
            {/* Error toast */}
            <AnimatePresence>
                {apiError && (
                    <motion.div
                        role="alert"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="pointer-events-auto fixed right-6 z-42 min-w-[240px] max-w-[360px] rounded-[18px] border border-white/[.08] text-[13px] leading-[1.5] mb-2"
                        style={{ bottom: 170, padding: "14px 16px", background: "rgba(12,12,12,.96)", boxShadow: "0 28px 80px rgba(0,0,0,.42)" }}
                    >
                        <div className="flex items-center gap-2 text-[#ffc4c4]" style={{ borderColor: "rgba(255,128,128,.22)" }}>
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span className="flex-1">{apiErrorDetail ?? (tErrors.has(apiError as never) ? tErrors(apiError as never) : tErrors("ERR_GENERIC"))}</span>
                            <button onClick={() => setApiError(null)} className="font-bold hover:opacity-70">×</button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {pendingGeneration && (
                <div className="mx-auto mb-3 flex items-center gap-3 rounded-2xl border border-[#ff4d4d]/25 bg-[#111111] px-4 py-3 text-white shadow-xl" style={{ width: "min(70rem, 100%)" }}>
                    <Loader2 aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin text-[#ff4d4d]" />
                    <div className="min-w-0 flex-1" role="status" aria-live="polite">
                        <p className="text-sm font-semibold">{tCommand("generationPending", { model: pendingGeneration.model })}</p>
                        <p className="mt-1 text-xs text-white/65">{pendingGeneration.progress || tCommand("generationWait")}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-[#ff4d4d]" aria-label={tCommand("generationElapsed", { seconds: elapsedSeconds })}>{elapsedSeconds}s</span>
                </div>
            )}

            {/* Composer stage — matches Flask grid */}
            <form
                aria-busy={isGenerating}
                onSubmit={handleSubmit(onSubmit)}
                className="pointer-events-auto mx-auto"
                style={{ width: "min(70rem, 100%)" }}
            >
                {/* Composer card */}
                <div
                    className="rounded-[28px] border border-white/[.08] flex flex-col items-stretch gap-3 sm:flex-row"
                    style={{
                        backdropFilter: "blur(26px)",
                        background: "radial-gradient(circle at 92% 82%, rgba(255,77,77,.07), transparent 18%), linear-gradient(90deg, rgba(12,12,12,.96), rgba(20,20,20,.92) 52%, rgba(24,24,24,.88))",
                        boxShadow: "0 28px 80px rgba(0,0,0,.42)",
                        padding: "12px",
                    }}
                >
                    {/* Content: prompt + pills */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                        {/* Main prompt area */}
                        <div className="flex items-start gap-2">
                            {/* Plus / attach button */}
                            {mode === "video" && videoHasAttachments(videoModel) ? (
                                <AttachmentButton
                                    model={videoModel}
                                    attachments={attachments}
                                    onAttachmentsChange={setAttachments}
                                />
                            ) : mode !== "video" && imageUploadSlots.length > 0 ? (
                                <ImageAttachmentButton
                                    slots={imageUploadSlots}
                                    slotFiles={slotFiles}
                                    onSlotFilesChange={setSlotFiles}
                                />
                            ) : mode === "video" ? (
                                <button
                                    type="button"
                                    className="w-8 h-8 border border-white/[.08] rounded-xl text-base font-medium leading-none cursor-pointer self-start grid place-items-center text-foreground shrink-0"
                                    style={{ background: "rgba(255,255,255,.05)" }}
                                >
                                    +
                                </button>
                            ) : null}

                            {/* Image slot thumbnails */}
                            {mode !== "video" && Object.values(slotFiles).some((f) => f.length > 0) && (
                                <div className="flex items-center gap-[5px] flex-wrap shrink-0">
                                    {Object.entries(slotFiles).flatMap(([slotId, files]) =>
                                        files.map((file, idx) => (
                                            <div key={`${slotId}-${idx}`} className="relative w-[50px] h-[50px] shrink-0">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={URL.createObjectURL(file)} alt="" className="block object-cover rounded-[9px] w-[50px] h-[50px] border border-white/[.12]" />
                                                <button
                                                    type="button"
                                                    onClick={() => setSlotFiles((prev) => ({
                                                        ...prev,
                                                        [slotId]: (prev[slotId] ?? []).filter((_, i) => i !== idx),
                                                    }))}
                                                    className="absolute -top-[5px] -right-[5px] w-4 h-4 rounded-full border border-white/[.20] text-white text-[9px] grid place-items-center leading-none"
                                                    style={{ background: "rgba(20,20,20,.92)", zIndex: 2 }}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {/* Video attachment thumbnails */}
                            {mode === "video" && attachments.length > 0 && (
                                <div className="flex items-center gap-[5px] flex-wrap shrink-0">
                                    {attachments.map((att) => (
                                        <div key={att.id} className="relative w-[50px] h-[50px] shrink-0">
                                            {att.previewUrl ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={att.previewUrl} alt="" className="block object-cover rounded-[9px] w-[50px] h-[50px] border border-white/[.12]" />
                                            ) : (
                                                <div className="rounded-[9px] grid place-items-center text-[20px] border border-white/[.10] w-[50px] h-[50px]" style={{ background: "rgba(255,255,255,.06)" }}>
                                                    📎
                                                </div>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => setAttachments(attachments.filter((a) => a.id !== att.id))}
                                                className="absolute -top-[5px] -right-[5px] w-4 h-4 rounded-full border border-white/[.20] text-white text-[9px] grid place-items-center leading-none"
                                                style={{ background: "rgba(20,20,20,.92)", zIndex: 2 }}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Prompt surface */}
                            <div className="flex-1 min-w-0 min-h-8">
                                {isDragOverlayVisible && hasDropTargets ? (
                                    <div
                                        className="rounded-[14px] border border-dashed p-2.5"
                                        style={{ borderColor: "rgba(255,77,77,.44)", background: "rgba(255,77,77,.06)" }}
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                        onDrop={(e) => {
                                            if (dropTargets.length === 1) {
                                                handleDropToTarget(dropTargets[0], e);
                                                return;
                                            }
                                            e.preventDefault();
                                        }}
                                    >
                                        {dropTargets.length === 1 ? (
                                            <div className="px-2 py-3 text-center">
                                                <p className="text-[11px] font-bold uppercase tracking-[.08em]" style={{ color: "rgba(255,77,77,.92)" }}>
                                                    {tCommand("dropSingleTitle", { field: dropTargets[0].label })}
                                                </p>
                                                <p className="mt-1 text-[12px]" style={{ color: "rgba(244,247,251,.72)" }}>
                                                    {tCommand("dropSingleHint")}
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="grid gap-2 sm:grid-cols-2">
                                                {dropTargets.map((target) => (
                                                    <div
                                                        key={target.id}
                                                        className="rounded-[10px] border px-2.5 py-2 transition-colors"
                                                        style={{
                                                            borderColor: activeDropTargetId === target.id ? "rgba(255,77,77,.64)" : "rgba(255,255,255,.16)",
                                                            background: activeDropTargetId === target.id ? "rgba(255,77,77,.14)" : "rgba(255,255,255,.04)",
                                                        }}
                                                        onDragEnter={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            setActiveDropTargetId(target.id);
                                                        }}
                                                        onDragOver={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            if (activeDropTargetId !== target.id) setActiveDropTargetId(target.id);
                                                        }}
                                                        onDragLeave={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            setActiveDropTargetId((current) => (current === target.id ? null : current));
                                                        }}
                                                        onDrop={(e) => handleDropToTarget(target, e)}
                                                    >
                                                        <p className="text-[11px] font-bold" style={{ color: "#f4f7fb" }}>
                                                            {target.label}
                                                        </p>
                                                        <p className="mt-0.5 text-[10px]" style={{ color: "rgba(244,247,251,.58)" }}>
                                                            {target.kind.toUpperCase()} {target.required ? `• ${tCommand("required")}` : `• ${tCommand("optional")}`}
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <textarea
                                        ref={textareaRef}
                                        rows={1}
                                        value={prompt}
                                        onChange={(e) => { setValue("prompt", e.target.value); autoResize(); }}
                                        onKeyDown={handleKeyDown}
                                        placeholder={mode === "carousel" ? "Describe tu carrusel: tema, público, mensaje y llamada a la acción…" : mode === "video" ? t("video.promptPlaceholder") : t("image.promptPlaceholder")}
                                        className="w-full border-none bg-transparent resize-none outline-none text-[15px] font-normal min-h-8 py-1.5 box-border text-foreground leading-[1.3]"
                                        style={{
                                            maxHeight: "35dvh",
                                            overflowY: "auto",
                                            overflowX: "hidden",
                                        }}
                                    />
                                )}
                            </div>
                        </div>

                        {/* Control row (pills) */}
                        <div className="flex flex-wrap items-center gap-2 mt-[2px]">
                            <StudioModePill mode={mode} onModeChange={onModeChange} disabled={isGenerating} />
                            <DesignSystemPill brands={brands} selectedId={selectedBrandId} loading={brandsLoading} onSelect={selectBrand} />
                            <CharacterPill characters={characters} selectedId={selectedCharacterId} onSelect={setSelectedCharacterId} />
                            <CompanySelect companies={companySelection.companies} selectedId={companySelection.selectedId} onSelect={companySelection.select} />
                            {mode === "video" ? (
                                <>
                                    <VideoModelPill
                                        modelId={videoModelId}
                                        variantId={videoVariantId}
                                        onModelChange={handleVideoModelChange}
                                        attachments={attachments}
                                    />
                                    {getDurations(videoModel).length > 0 && (
                                        <DurationPill
                                            durations={getDurations(videoModel)}
                                            value={videoSettings.duration}
                                            onChange={(d) => setVideoSettings((s) => ({ ...s, duration: d }))}
                                        />
                                    )}
                                    {(getAspectRatios(videoModel)?.length ?? 0) > 0 && !attachments.some(a => a.kind === "image") && (
                                        <AspectRatioPill
                                            ratios={getAspectRatios(videoModel)!}
                                            value={videoSettings.aspectRatio}
                                            onChange={(r) => setVideoSettings((s) => ({ ...s, aspectRatio: r }))}
                                        />
                                    )}
                                    {videoModel.prompt_expansion && (
                                        <TogglePill
                                            label={t("video.expandPrompt")}
                                            icon="sparkle"
                                            value={videoSettings.expandPrompt}
                                            onChange={(v) => setVideoSettings((s) => ({ ...s, expandPrompt: v }))}
                                        />
                                    )}
                                    <VideoControlsPill
                                        model={videoModel}
                                        settings={videoSettings}
                                        onSettingsChange={setVideoSettings}
                                    />
                                </>
                            ) : (
                                <>
                                    <ImageModelPill
                                        modelId={imageModelId}
                                        onModelChange={handleImageModelChange}
                                        slotFiles={slotFiles}
                                        carouselMode={mode === "carousel"}
                                    />
                                    {imageRatios.length > 0 && (
                                        <AspectRatioPill
                                            ratios={imageRatios}
                                            allowAuto={false}
                                            selectedValues={mode === "carousel" ? selectedImageFormats.slice(0, 1) : selectedImageFormats}
                                            onSelectedValuesChange={setSelectedImageFormats}
                                            multiSelect={mode === "image" && imageUploadSlots.some((slot) => slot.kind === "image")}
                                            customFields={mode === "image" ? imageCustomFields : null}
                                            fieldValues={imageFieldValues}
                                            onFieldChange={(id, val) => setImageFieldValues((prev) => ({ ...prev, [id]: val }))}
                                        />
                                    )}
                                    {imageRatios.length === 0 && (
                                        <span title="Este modelo no publica formatos seleccionables; generará con su formato predeterminado." className="inline-flex items-center rounded-full border border-white/10 bg-white/[.035] px-3 py-2 text-xs font-medium text-white/55">Formato automático</span>
                                    )}
                                    {imageResolutions.length > 0 && (
                                        <ResolutionPill
                                            resolutions={imageResolutions}
                                            value={sizeResolution}
                                            onChange={setSizeResolution}
                                        />
                                    )}
                                    {mode === "carousel" && <PillPopover open={carouselCountOpen} onOpenChange={setCarouselCountOpen} width="w-56" trigger={<><Layers3 className="h-4 w-4" /><span>{carouselSlideCount} imágenes</span></>}><p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.08em] text-white/45">Páginas del carrusel</p><div className="grid grid-cols-5 gap-1.5">{Array.from({ length: 9 }, (_, index) => index + 2).map(count => <button key={count} type="button" aria-pressed={carouselSlideCount === count} onClick={() => { setCarouselSlideCount(count); setCarouselCountOpen(false); }} className={`rounded-lg px-2 py-2 text-xs font-bold ${carouselSlideCount === count ? "bg-[#c62828] text-white" : "bg-white/5 text-white hover:bg-white/10"}`}>{count}</button>)}</div><p className="mt-3 text-[11px] leading-relaxed text-white/45">Una imagen por página, con una sola historia y estilo visual.</p></PillPopover>}
                                    {mode === "image" && imageModel.custom_fields?.some((f) => f.type === "checkbox" && f.id.includes("prompt")) && (
                                        <TogglePill
                                            label={t("image.enhancePrompt")}
                                            icon="sparkle"
                                            value={Boolean(imageFieldValues[imageModel.custom_fields!.find((f) => f.type === "checkbox" && f.id.includes("prompt"))!.id] ?? false)}
                                            onChange={(v) => {
                                                const fid = imageModel.custom_fields!.find((f) => f.type === "checkbox" && f.id.includes("prompt"))!.id;
                                                setImageFieldValues((prev) => ({ ...prev, [fid]: v }));
                                            }}
                                        />
                                    )}
                                    {mode === "image" && imageControlCount > 0 && (
                                        <ControlsPill
                                            model={imageModel}
                                            fieldValues={imageFieldValues}
                                            onFieldChange={(id, val) => setImageFieldValues((prev) => ({ ...prev, [id]: val }))}
                                            count={imageControlCount}
                                        />
                                    )}
                                </>
                            )}
                        </div>
                        {mode !== "video" && <GenerationPrice key={imageModelId} model={imageModel} resolution={sizeResolution || String(imageFieldValues.resolution || "")} aspectRatio={sizeAspect || String(imageFieldValues.aspect_ratio || "")} quality={String(imageFieldValues.quality || "")} count={mode === "carousel" ? carouselSlideCount : selectedExtraFormatCount ? 1 + selectedExtraFormatCount : Number(imageFieldValues.n ?? 1)} />}
                    </div>{/* end content wrapper */}

                    {/* Generate button — flex end, large red */}
                    <button
                        type="submit"
                        disabled={isGenerating || !hasSelectedActiveApi}
                        title={hasSelectedActiveApi ? undefined : "Conecta una API para elegir un modelo"}
                        className="w-full min-h-14 shrink-0 self-center border-none rounded-[22px] font-bold cursor-pointer active:scale-95 transition-transform disabled:cursor-wait disabled:opacity-75 disabled:active:scale-100 sm:w-[146px] sm:min-h-[84px]"
                        style={{
                            background: "linear-gradient(180deg, #d32f2f, #b71c1c)",
                            color: "#ffffff",
                            fontFamily: "'Space Grotesk', system-ui, sans-serif",
                            fontSize: 18,
                            letterSpacing: "-0.04em",
                            boxShadow: "0 20px 42px rgba(229,56,56,.18)",
                        }}
                    >
                        <span className="flex items-center justify-center gap-2">
                            {isGenerating && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                            {isGenerating ? tCommon("generating") : mode === "carousel" ? `Generar ${carouselSlideCount} imágenes` : selectedExtraFormatCount > 0 && mode === "image" ? `Generar ${1 + selectedExtraFormatCount} formatos` : tCommon("generate")}
                        </span>
                        <small className="block mt-1 text-[10px] font-extrabold tracking-[.08em] uppercase" style={{ fontFamily: "'Manrope', sans-serif" }}>
                            {mode === "video" ? tCommon("video") : mode === "carousel" ? "CARRUSEL" : tCommon("image")}
                        </small>
                    </button>
                </div>
            </form>
        </div>
    );
}
