export type MediaType = "video" | "image";

export interface SizeUiAspectRatio {
    id: string;
    w: number;
    h: number;
}

export interface SizeUiResolution {
    id: string;
    base: number;
}

export interface SizeUi {
    width_field: string;
    height_field: string;
    aspect_ratios: SizeUiAspectRatio[];
    resolutions: SizeUiResolution[];
    default_aspect: string;
    default_resolution: string;
}

// Task types
export type TaskStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "ERROR" | "CANCELLED";

export interface TaskEvent {
    type: "status" | "completed" | "failed" | "timeout" | "error";
    status?: string;
    elapsed?: number;
    video_urls?: string[];
    has_download?: boolean;
    media_type?: MediaType;
    result_urls?: string[];
    result_count?: number;
    message?: string;
}

export interface VideoTask {
    task_id: string;
    company_id?: string;
    status?: string;
    provider_id?: "freepik" | "google-ai-studio" | "google-vertex" | "vercel-ai-gateway" | "openrouter" | "openai" | "higgsfield" | "api-market" | "apimart";
    provider_model_id?: string;
    provider_connection_id?: string;
    provider_task_id?: string;
    provider_operation?: unknown;
    freepik_task_id?: string;
    freepik_status?: string;
    prompt?: string;
    image_url?: string;
    params?: Record<string, unknown>;
    model_id: string;
    poll_url?: string;
    created_at: string;
    video_path?: string;
    video_urls?: string[];
    media_type: "video";
    response_style?: string;
    result_paths?: string[];
    result_urls?: string[];
    reuse_state?: Record<string, unknown>;
    error_message?: string;
    events?: TaskEvent[];
    _done?: boolean;
}

export interface ImageTask {
    task_id: string;
    company_id?: string;
    status?: string;
    provider_id?: "freepik" | "google-ai-studio" | "google-vertex" | "vercel-ai-gateway" | "openrouter" | "openai" | "higgsfield" | "api-market" | "apimart";
    provider_model_id?: string;
    provider_connection_id?: string;
    provider_task_id?: string;
    provider_operation?: unknown;
    freepik_task_id?: string | null;
    freepik_status?: string;
    prompt?: string;
    params?: Record<string, unknown>;
    model_id: string;
    poll_url?: string | null;
    created_at: string;
    media_type: "image";
    /** Internal editor resources (for example decomposed layers) stay out of libraries. */
    internal_kind?: "layer";
    response_style?: string;
    result_paths?: string[];
    result_urls?: string[];
    image_urls?: string[];
    reuse_state?: Record<string, unknown>;
    error_message?: string;
    events?: TaskEvent[];
    _done?: boolean;
}

export interface ImageLayerMetadata {
    index: number;
    zIndex: number;
    name: string;
    description: string;
    size: { width: number; height: number };
    role?: "reference" | "base" | "layer";
    /** How the provider supplied the placement. Used to recover missing boxes safely. */
    boundingBoxSource?: "absolute" | "normalized" | "size" | "alpha" | "fallback";
    boundingBox: {
        absolute: [number, number, number, number];
        normalized: [number, number, number, number];
    };
}

export interface ImageLayerSet {
    version: 1 | 2 | 3 | 4;
    model: string;
    sourceWidth: number;
    sourceHeight: number;
    /** Canonical canvas used by the provider output and the editor. */
    canvasWidth?: number;
    canvasHeight?: number;
    /** All layer boxes are pixels in this canonical frame. */
    coordinateSpace?: "canonical-pixels";
    baseIndex: number;
    referenceIndex?: number;
    layers: ImageLayerMetadata[];
}

export type AnyTask = VideoTask | ImageTask;
