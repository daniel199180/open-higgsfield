export type ChatRole = "user" | "assistant";

export interface WebSource {
    title: string;
    url: string;
    snippet?: string;
}

export interface ChatMessage {
    id: string;
    sessionId: string;
    role: ChatRole;
    content: string;
    modelId?: string;
    sources?: WebSource[];
    attachmentNames?: string[];
    createdAt: string;
}

export interface ChatSession {
    id: string;
    title: string;
    modelId?: string;
    webSearch: boolean;
    reasoning: boolean;
    skillId?: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    archivedAt?: string;
}

export interface ChatSessionDetail extends ChatSession {
    messages: ChatMessage[];
}

export interface TextModel {
    id: string;
    label: string;
    provider: "openrouter" | "apimart" | "deepseek";
    providerModelId: string;
    providerConnectionId: string;
    contextLength?: number;
}
