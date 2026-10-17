export interface BrandSystem {
    id: string;
    name: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    headingFont: string;
    subheadingFont?: string;
    bodyFont: string;
    secondaryBodyFont?: string;
    voice: string;
    visualRules: string;
    negativePrompt?: string;
    references?: Array<{ assetId: string; name: string }>;
    logoAssetId?: string;
    logoAssetIds?: string[];
    logoVectorAssetId?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CharacterSnapshot {
    id: string;
    version: number;
    name: string;
    description: string;
    visualRules: string;
    referenceAssetIds: string[];
    soulId?: string;
    soulConnectionId?: string;
    soulStatus?: "queued" | "in_progress" | "completed" | "failed";
}

export interface Character extends CharacterSnapshot {
    brandId?: string;
    coverAssetId: string;
    archivedAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface LogoResult {
    id: string;
    companyId?: string;
    brandId?: string;
    mode: "create" | "redraw" | "trace";
    prompt: string;
    modelId?: string;
    sourceAssetId?: string;
    vectorAssetId: string;
    previewAssetId: string;
    createdAt: number;
}

export type SocialFormat = "post-square" | "post-portrait" | "story" | "carousel";
export interface CarouselSlide {
    id: string;
    role: string;
    title: string;
    body: string;
    visualPrompt: string;
    taskIds: string[];
    sourceTaskId?: string;
}
export interface SocialProject {
    id: string;
    companyId?: string;
    name: string;
    brandId: string;
    character?: CharacterSnapshot;
    format: SocialFormat;
    language: string;
    brief: string;
    modelId: string;
    slideCount: number;
    taskIds: string[];
    aspectRatio?: string;
    resolution?: string;
    /** Provider controls selected when the project was created. */
    fieldValues?: Record<string, string | number | boolean>;
    slides?: CarouselSlide[];
    autoStory?: boolean;
    sourceProjectId?: string;
    status: "draft" | "generating" | "completed" | "partial";
    createdAt: number;
    updatedAt: number;
}
