export interface SavedPrompt {
    id: string;
    title: string;
    prompt: string;
    negativePrompt?: string;
    tags: string[];
    sourceImageUrl?: string;
    createdAt: number;
    updatedAt: number;
}
