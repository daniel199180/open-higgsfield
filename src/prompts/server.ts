import "server-only";
import crypto from "node:crypto";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import type { SavedPrompt } from "./types";

export async function listSavedPrompts(): Promise<SavedPrompt[]> {
    return (await workflowStore().list<SavedPrompt>("prompt:"))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePrompt(input: {
    id?: string;
    title: string;
    prompt: string;
    negativePrompt?: string;
    tags?: string[];
    sourceImageUrl?: string;
}): Promise<SavedPrompt> {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title || title.length > 120) throw new WorkflowError("Escribe un título de hasta 120 caracteres.");
    if (!prompt || prompt.length > 12000) throw new WorkflowError("El prompt debe tener entre 1 y 12.000 caracteres.");
    if (input.id && !/^[0-9a-f-]{36}$/i.test(input.id)) throw new WorkflowError("El prompt no es válido.", 400);

    const now = Date.now();
    return workflowStore().transaction(docs => {
        const id = input.id ?? crypto.randomUUID();
        const previous = docs.get(`prompt:${id}`) as SavedPrompt | undefined;
        if (input.id && !previous) throw new WorkflowError("El prompt ya no existe.", 404);
        const value: SavedPrompt = {
            id,
            title,
            prompt,
            ...(input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim().slice(0, 4000) } : {}),
            tags: [...new Set((input.tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
            ...(input.sourceImageUrl ? { sourceImageUrl: input.sourceImageUrl.slice(0, 1000) } : {}),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        docs.set(`prompt:${id}`, value);
        return value;
    });
}

export async function deletePrompt(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WorkflowError("El prompt no es válido.", 400);
    await workflowStore().transaction(docs => {
        if (!docs.has(`prompt:${id}`)) throw new WorkflowError("El prompt ya no existe.", 404);
        docs.delete(`prompt:${id}`);
    });
}
