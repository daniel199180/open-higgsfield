import { IMAGE_CAPABILITIES_LIST } from "@/models/capabilities/image";
import { VIDEO_CAPABILITIES } from "@/models/capabilities/video";
import type { CustomFieldCapability, ModelCapabilities } from "@/models/capabilities/types";
import { expandApiMarketConnections, getConnectionForProvider, getStoredConnections, type ProviderConnection } from "@/lib/connection-store";
import { listApiMarketTools } from "@/providers/api-market-client";
import { providerFetch } from "./secure-fetch";
import { isCarouselProviderModel } from "@/social/carousel-models";

type MediaType = "image" | "video";

function runtimeId(provider: string, mediaType: MediaType, connectionId: string, upstreamId: string): string {
    return `${provider}:${mediaType}:${encodeURIComponent(connectionId)}:${encodeURIComponent(upstreamId)}`;
}

function baseCapability(input: Partial<ModelCapabilities> & Pick<ModelCapabilities, "id" | "label" | "group">): ModelCapabilities {
    return {
        id: input.id,
        label: input.label,
        family: input.family ?? input.group,
        variant: input.variant ?? "",
        group: input.group,
        category: input.category,
        provider: input.provider,
        provider_model_id: input.provider_model_id,
        provider_connection_id: input.provider_connection_id,
        provider_mode: input.provider_mode,
        prompt_required: input.prompt_required ?? true,
        prompt_supported: input.prompt_supported ?? true,
        prompt_max: input.prompt_max,
        duration: input.duration ?? false,
        aspect_ratio: input.aspect_ratio ?? false,
        size: input.size ?? false,
        resolution_variant: input.resolution_variant ?? false,
        variant_overrides: input.variant_overrides,
        negative_prompt: input.negative_prompt ?? false,
        cfg_scale: input.cfg_scale ?? false,
        style: input.style ?? false,
        shot_type: input.shot_type ?? false,
        prompt_expansion: input.prompt_expansion ?? false,
        elements: input.elements ?? false,
        media_slots: input.media_slots ?? [],
        custom_fields: input.custom_fields ?? [],
        sort_key: input.sort_key ?? 1000,
    };
}

function fieldOptions(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (!value || typeof value !== "object") return [];
    const descriptor = value as { values?: unknown[]; options?: unknown[] };
    const options = descriptor.values ?? descriptor.options;
    return Array.isArray(options) ? options.filter((item): item is string => typeof item === "string") : [];
}

function numericField(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["max", "maximum", "max_length", "maxLength"]) {
        if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
    }
    return undefined;
}

function openRouterHeaders(connection: ProviderConnection): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${connection.credentials.apiKey}` };
    if (connection.config.httpReferer) headers["HTTP-Referer"] = connection.config.httpReferer;
    if (connection.config.appTitle) headers["X-OpenRouter-Title"] = connection.config.appTitle;
    return headers;
}

async function openRouterModels(connection: ProviderConnection, mediaType: MediaType): Promise<ModelCapabilities[]> {
    const base = (connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const path = mediaType === "image" ? "/images/models" : "/videos/models";
    const response = await providerFetch("openrouter", `${base}${path}`, { headers: openRouterHeaders(connection), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => ({})) as { data?: Array<Record<string, unknown>> };
    return (payload.data ?? []).map((model, index) => {
        const id = String(model.id ?? model.canonical_slug ?? `model-${index}`);
        const label = String(model.name ?? id);
        const supported = (model.supported_parameters ?? {}) as Record<string, unknown>;
        const architecture = (model.architecture ?? {}) as { input_modalities?: unknown[] };
        if (mediaType === "image") {
            const customFields: CustomFieldCapability[] = [];
            const ratios = fieldOptions(supported.aspect_ratio);
            const resolutions = fieldOptions(supported.resolution);
            if (ratios.length) customFields.push({ id: "aspect_ratio", label: "Aspect ratio", type: "select", options: ratios, default: ratios[0] });
            if (resolutions.length) customFields.push({ id: "resolution", label: "Resolution", type: "select", options: resolutions, default: resolutions[0] });
            if (supported.seed) customFields.push({ id: "seed", label: "Seed", type: "number" });
            if (supported.quality) customFields.push({ id: "quality", label: "Quality", type: "select", options: fieldOptions(supported.quality) });
            return baseCapability({
                id: runtimeId("openrouter", "image", connection.id, id),
                label,
                family: "OpenRouter",
                variant: id,
                group: "OpenRouter",
                category: "Generate",
                provider: "openrouter",
                provider_model_id: id,
                provider_connection_id: connection.id,
                provider_mode: "native-image",
                prompt_max: numericField(supported.prompt) ?? numericField(model.prompt_max),
                // GPT Image and Nano Banana accept input references even when
                // a provider catalog omits input_modalities for that endpoint.
                media_slots: (architecture.input_modalities ?? []).includes("image") || isCarouselProviderModel("openrouter", id, String(model.name ?? ""))
                    ? [{ id: "input_references", label: "Reference images", kind: "image", multiple: true }] : [],
                custom_fields: customFields,
                sort_key: 7000 - index,
            });
        }

        const durations = Array.isArray(model.supported_durations)
            ? model.supported_durations.filter((value): value is number => typeof value === "number").map(String)
            : [];
        const ratios = Array.isArray(model.supported_aspect_ratios)
            ? model.supported_aspect_ratios.filter((value): value is string => typeof value === "string")
            : [];
        const resolutions = Array.isArray(model.supported_resolutions)
            ? model.supported_resolutions.filter((value): value is string => typeof value === "string")
            : [];
        const modelText = `${id} ${label}`.toLowerCase();
        const inputModalities = [
            ...(Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []),
            ...(Array.isArray(model.input_modalities) ? model.input_modalities : []),
        ].map((value) => String(value).toLowerCase());
        // OpenRouter currently documents Seedance 2.x as the multimodal
        // reference family. Keep metadata checks for future catalog entries.
        const seedanceReferences = /seedance[-_.]?2(?:[.-]|$)/i.test(modelText);
        const acceptsReferenceImages = seedanceReferences || supported.input_references === true || supported.reference_images === true;
        const acceptsReferenceVideo = seedanceReferences || inputModalities.includes("video") || supported.reference_videos === true;
        const acceptsReferenceAudio = seedanceReferences || inputModalities.includes("audio") || supported.reference_audio === true;
        const referenceSlots = [
            ...(acceptsReferenceImages ? [{ id: "input_references", label: "Imágenes de referencia", kind: "image" as const, multiple: true, type: "reference" }] : []),
            ...(acceptsReferenceVideo ? [{ id: "reference_video", label: "Videos de referencia", kind: "video" as const, multiple: true, type: "reference" }] : []),
            ...(acceptsReferenceAudio ? [{ id: "reference_audio", label: "Audio de referencia", kind: "audio" as const, multiple: true, type: "reference" }] : []),
        ];
        const frameSlots = (model.supported_frame_images as unknown[] | undefined)?.map((role) => ({
            id: role === "last_frame" ? "end_image" : "start_image",
            label: role === "last_frame" ? "Last frame" : "First frame",
            kind: "image" as const,
        })) ?? [];
        return baseCapability({
            id: runtimeId("openrouter", "video", connection.id, id),
            label,
            family: "OpenRouter",
            variant: id,
            group: "OpenRouter",
            category: "Generate",
            provider: "openrouter",
            provider_model_id: id,
            provider_connection_id: connection.id,
            provider_mode: "video",
            duration: durations.length ? { options: durations, default: durations[0] } : false,
            aspect_ratio: ratios.length ? { options: ratios.map((ratio) => [ratio, ratio] as [string, string]), default: [ratios[0], ratios[0]] } : false,
            resolution_variant: resolutions.length ? { options: resolutions, default: resolutions[0] } : false,
            media_slots: [...frameSlots, ...referenceSlots],
            custom_fields: model.generate_audio ? [{ id: "generate_audio", label: "Generate audio", type: "checkbox", default: true }] : [],
            sort_key: 7000 - index,
        });
    });
}

function higgsfieldCatalog(connection: ProviderConnection, mediaType: MediaType): ModelCapabilities[] {
    const imageModels = [
        { id: "higgsfield-ai/soul/v2/standard", label: "Soul 2", group: "Higgsfield Images", ratios: ["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"], resolutions: ["720p", "1080p"] },
        { id: "z-image/turbo", label: "Z-Image Turbo", group: "Higgsfield Images", ratios: [], resolutions: ["1k", "2k"] },
        { id: "marketing-studio/image", label: "Marketing Studio Image", group: "Higgsfield Images", ratios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], resolutions: ["1k", "2k", "4k"] },
    ];
    const videoModels = [
        { id: "bytedance/seedance-2.0/text-to-video", label: "Seedance 2.0", group: "Higgsfield Video", ratios: ["16:9", "9:16", "1:1"], durations: ["5", "10", "15"], resolutions: ["720p", "1080p"] },
        { id: "kling-video/v3.0/std/text-to-video", label: "Kling 3.0 Standard", group: "Higgsfield Video", ratios: ["16:9", "9:16", "1:1"], durations: ["3", "5", "8", "10", "12", "15"], resolutions: ["720p", "1080p"] },
        { id: "wan/v2.7/text-to-video", label: "Wan 2.7", group: "Higgsfield Video", ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], durations: ["5", "10", "15"], resolutions: ["720p", "1080p"] },
    ];
    const source = mediaType === "image" ? imageModels : videoModels;
    return source.map((model, index) => baseCapability({
        id: runtimeId("higgsfield", mediaType, connection.id, model.id),
        label: model.label,
        family: model.group,
        variant: "",
        group: model.group,
        category: "Generate",
        provider: "higgsfield",
        provider_model_id: model.id,
        provider_connection_id: connection.id,
        provider_mode: mediaType === "image" ? "native-image" : "video",
        duration: mediaType === "video" ? { options: (model as { durations?: string[] }).durations ?? [], default: (model as { durations?: string[] }).durations?.[0] } : false,
        aspect_ratio: model.ratios.length ? { options: model.ratios.map((ratio) => [ratio, ratio] as [string, string]), default: [model.ratios[0], model.ratios[0]] } : false,
        resolution_variant: model.resolutions.length ? { options: model.resolutions, default: model.resolutions[0] } : false,
        media_slots: mediaType === "video" ? [{ id: "start_image", label: "Start frame", kind: "image" }, { id: "end_image", label: "End frame", kind: "image" }] : [],
        custom_fields: mediaType === "video" ? [{ id: "generate_audio", label: "Generate audio", type: "checkbox", default: true }] : [],
        sort_key: 6000 - index,
    }));
}

async function apiMarketCatalog(connection: ProviderConnection, mediaType: MediaType): Promise<ModelCapabilities[]> {
    const configuredType = connection.config.mediaType || "image";
    if (configuredType !== "both" && configuredType !== mediaType) return [];
    const tools = await listApiMarketTools(connection.config, connection.credentials.apiKey).catch(() => []);
    return tools
        .filter((tool) => !/^(get|list|status|delete|cancel)/i.test(tool.name))
        .filter((tool) => {
            const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
            return text.includes(mediaType) || /generate|create|predict|submit/.test(text);
        })
        .map((tool, index) => baseCapability({
            id: runtimeId("api-market", mediaType, connection.id, tool.name),
            label: tool.description?.slice(0, 80) || tool.name,
            family: connection.name,
            variant: tool.name,
            group: `API.market · ${connection.name}`,
            category: "Generate",
            provider: "api-market",
            provider_model_id: tool.name,
            provider_connection_id: connection.id,
            provider_mode: mediaType === "image" ? "native-image" : "video",
            duration: mediaType === "video" ? { options: ["5", "10"], default: "5" } : false,
            aspect_ratio: { options: [["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"]], default: ["16:9", "16:9"] },
            resolution_variant: mediaType === "video" ? { options: ["720p", "1080p"], default: "720p" } : false,
            media_slots: mediaType === "video" ? [{ id: "start_image", label: "Start frame", kind: "image" }] : [],
            custom_fields: [],
            sort_key: 5000 - index,
        }));
}

const APIMART_VIDEO_MODEL = /(?:video|seedance|kling|wan[-_.]?2|veo|sora|hunyuan|runway|luma|pika|mochi|cogvideo)/i;
const APIMART_IMAGE_MODEL = /(?:image|imagen|banana|seedream|flux|ideogram|midjourney|recraft|qwen[-_.]?image|z[-_.]?image|grok[-_.]?imagine|stable[-_.]?diffusion|sdxl|gpt[-_.]?image|openai[-_.]?gpt|gemini[-_.]?(?:2\.5|3))/i;

function apimartModelMediaType(model: Record<string, unknown>): MediaType | undefined {
    const id = String(model.id ?? model.model ?? "");
    const text = `${id} ${String(model.type ?? "")} ${String(model.modality ?? "")}`;
    if (APIMART_VIDEO_MODEL.test(text)) return "video";
    if (APIMART_IMAGE_MODEL.test(text)) return "image";
    return undefined;
}

function apimartCapabilities(connection: ProviderConnection, mediaType: MediaType, model: Record<string, unknown>, index: number): ModelCapabilities {
    const id = String(model.id ?? model.model);
    const label = String(model.name ?? model.display_name ?? id);
    const image = mediaType === "image";
    // APIMart's model list is not a universal schema. Only advertise options
    // declared for this model; sending invented quality/reference fields makes
    // otherwise valid carousel requests fail with an opaque 400.
    const supported = (model.supported_parameters ?? model.parameters ?? {}) as Record<string, unknown>;
    const ratios = fieldOptions(supported.aspect_ratio ?? model.aspect_ratios);
    const resolutions = fieldOptions(supported.resolution ?? model.resolutions);
    const qualities = fieldOptions(supported.quality);
    const inputModes = fieldOptions(supported.input_modalities ?? model.input_modalities).map((value) => value.toLowerCase());
    const modelText = `${id} ${label}`.toLowerCase();
    // APIMart's model list is inconsistent across versions. Keep explicit
    // metadata checks plus the documented multimodal families so the UI does
    // not hide reference inputs when a catalog response omits those flags.
    const multimodalReferences = /seedance[-_.]?2(?:[.-]|$)|wan[-_.]?3(?:[.-]|$)|minimax[-_.]?h3|vidu[-_.]?q4/i.test(modelText);
    const acceptsReferences = inputModes.includes("image") || supported.image_urls === true || supported.reference_images === true || multimodalReferences || isCarouselProviderModel("apimart", id, label);
    const acceptsReferenceVideo = inputModes.includes("video") || supported.video_urls === true || multimodalReferences;
    const acceptsReferenceAudio = inputModes.includes("audio") || supported.audio_urls === true || supported.reference_audio === true || multimodalReferences;
    const displayRatios = ratios.length ? ratios : image ? ["1:1"] : ["16:9", "9:16", "1:1"];
    return baseCapability({
        id: runtimeId("apimart", mediaType, connection.id, id),
        label,
        family: "APIMart",
        variant: id,
        group: "APIMart",
        category: "Generate",
        provider: "apimart",
        provider_model_id: id,
        provider_connection_id: connection.id,
        provider_mode: image ? "native-image" : "video",
        prompt_max: numericField(supported.prompt) ?? numericField(model.prompt_max),
        duration: image ? false : { options: ["3", "5", "8", "10", "15"], default: "5" },
        // A single 1:1 fallback keeps text-only image generation usable when
        // APIMart omits metadata, without claiming every model supports 4K or
        // every canvas shape.
        aspect_ratio: { options: displayRatios.map((ratio) => [ratio, ratio] as [string, string]), default: [displayRatios[0], displayRatios[0]] },
        resolution_variant: image ? (resolutions.length ? { options: resolutions, default: resolutions[0] } : false) : { options: resolutions.length ? resolutions : ["480p", "720p", "1080p"], default: (resolutions.length ? resolutions : ["480p", "720p", "1080p"])[0] },
        media_slots: image
            ? (acceptsReferences ? [{ id: "input_references", label: "Imágenes de referencia", kind: "image", multiple: true, type: "reference" }] : [])
            : [
                { id: "start_image", label: "Primer fotograma", kind: "image" },
                { id: "end_image", label: "Último fotograma", kind: "image" },
                ...(acceptsReferences ? [{ id: "input_references", label: "Imágenes de referencia", kind: "image" as const, multiple: true, type: "reference" }] : []),
                ...(acceptsReferenceVideo ? [{ id: "reference_video", label: "Videos de referencia", kind: "video" as const, multiple: true, type: "reference" }] : []),
                ...(acceptsReferenceAudio ? [{ id: "reference_audio", label: "Audio de referencia", kind: "audio" as const, multiple: true, type: "reference" }] : []),
            ],
        custom_fields: image
            ? (qualities.length ? [{ id: "quality", label: "Calidad", type: "select", options: qualities, default: qualities[0] }] : [])
            : [{ id: "generate_audio", label: "Generar audio", type: "checkbox", default: false }],
        sort_key: 5500 - index,
    });
}

async function apimartCatalog(connection: ProviderConnection, mediaType: MediaType): Promise<ModelCapabilities[]> {
    const response = await providerFetch("apimart", "/v1/models", {
        headers: { Authorization: `Bearer ${connection.credentials.apiKey}` },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => ({})) as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];
    return payload.data
        .filter((model): model is Record<string, unknown> => !!model && typeof model === "object" && !Array.isArray(model))
        .filter((model) => apimartModelMediaType(model) === mediaType)
        .map((model, index) => apimartCapabilities(connection, mediaType, model, index));
}

async function providerConnections(provider: "openrouter" | "higgsfield" | "api-market" | "apimart"): Promise<ProviderConnection[]> {
    const stored = await getStoredConnections(provider);
    const env = await getConnectionForProvider(provider);
    if (env && !stored.some((connection) => connection.id === env.id)) stored.push(env);
    const active = stored.filter((connection) => connection.enabled);
    return provider === "api-market" ? expandApiMarketConnections(active) : active;
}

export async function getDynamicCatalog(mediaType: MediaType): Promise<ModelCapabilities[]> {
    const result: ModelCapabilities[] = [];
    for (const connection of await providerConnections("openrouter")) {
        result.push(...await openRouterModels(connection, mediaType).catch(() => []));
    }
    for (const connection of await providerConnections("higgsfield")) {
        result.push(...higgsfieldCatalog(connection, mediaType));
    }
    const marketConnections = await providerConnections("api-market");
    for (let start = 0; start < marketConnections.length; start += 6) {
        const batch = await Promise.all(marketConnections.slice(start, start + 6).map((connection) => apiMarketCatalog(connection, mediaType).catch(() => [])));
        result.push(...batch.flat());
    }
    for (const connection of await providerConnections("apimart")) {
        result.push(...await apimartCatalog(connection, mediaType).catch(() => []));
    }
    return result;
}

export async function getCatalog(mediaType: MediaType): Promise<ModelCapabilities[]> {
    const staticModels = mediaType === "image" ? IMAGE_CAPABILITIES_LIST : Object.values(VIDEO_CAPABILITIES);
    const dynamic = await getDynamicCatalog(mediaType);
    return [...staticModels, ...dynamic];
}

export async function findCapability(mediaType: MediaType, modelId: string): Promise<ModelCapabilities | undefined> {
    return (await getCatalog(mediaType)).find((model) => model.id === modelId);
}

export function isRuntimeModel(modelId: string): boolean {
    return /^(openrouter|higgsfield|api-market|apimart):(image|video):/.test(modelId);
}

export function runtimeProviderModelId(modelId: string): string | undefined {
    const parts = modelId.split(":");
    if (parts.length < 4) return undefined;
    try { return decodeURIComponent(parts.slice(3).join(":")); } catch { return undefined; }
}

export function runtimeConnectionId(modelId: string): string | undefined {
    const parts = modelId.split(":");
    if (parts.length < 4) return undefined;
    try { return decodeURIComponent(parts[2]); } catch { return undefined; }
}

export function staticCapability(mediaType: MediaType, modelId: string): ModelCapabilities | undefined {
    return mediaType === "image" ? IMAGE_CAPABILITIES_LIST.find((model) => model.id === modelId) : VIDEO_CAPABILITIES[modelId];
}
