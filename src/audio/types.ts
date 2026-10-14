export interface SavedVoice {
    id: string;
    provider: "elevenlabs";
    connectionId: string;
    providerVoiceId: string;
    name: string;
    origin: "designed" | "cloned";
    requiresVerification?: boolean;
    description?: string;
    createdAt: string;
}

export interface VoicePreview {
    id: string;
    connectionId: string;
    description: string;
    createdAt: string;
}

export interface AudioResult {
    id: string;
    companyId?: string;
    provider: "elevenlabs" | "openrouter";
    connectionId: string;
    model: string;
    text: string;
    assetId: string;
    voiceName: string;
    createdAt: string;
}
