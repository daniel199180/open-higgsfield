import type { ProviderId } from "@/providers/types";

/** Missing means not reported, never free/zero. Only provider-reported USD belongs here. */
export interface GenerationUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
}
export interface PriceSelection {
    provider: ProviderId;
    connectionId?: string;
    model: string;
    resolution?: string;
    quality?: string;
    aspectRatio?: string;
    size?: string;
}
export interface PriceQuote {
    source: "openrouter" | "manual" | "unavailable";
    minUsd?: number;
    maxUsd?: number;
    outputTokens?: number;
    rates?: { billable: string; unit: string; minUsd: number; maxUsd: number }[];
    note: string;
    checkedAt: string;
}
export interface UsageRecord extends GenerationUsage {
    id: string;
    provider: string;
    connection: string;
    model: string;
    label: string;
    media: "image" | "video";
    source: "studio" | "workflow";
    created: string;
    status: string;
    estimateMin?: number;
    estimateMax?: number;
}
export interface UsageGroup {
    provider: string;
    connection: string;
    model: string;
    label: string;
    requests: number;
    costUsd: number | null;
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costKnown: number;
    tokensKnown: number;
    estimateMin: number | null;
    estimateMax: number | null;
    estimated: number;
}
export interface AccountUsage {
    connection: string;
    name: string;
    provider: string;
    status: "ok" | "unavailable" | "error";
    totalUsd?: number;
    monthUsd?: number;
    todayUsd?: number;
    note: string;
}
export interface UsageSummary {
    groups: UsageGroup[];
    recent: UsageRecord[];
    connections: { id: string; name: string; provider: string }[];
    accounts?: AccountUsage[];
}
