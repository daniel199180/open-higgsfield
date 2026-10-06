import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { STORAGE_ROOT } from "@/lib/storage-paths";
import type { ProviderId } from "@/providers/types";
import { atomicJson, vaultKey, withSecurityLock } from "./security-store";

export interface ProviderConnection {
    id: string;
    provider: ProviderId;
    name: string;
    enabled: boolean;
    isDefault: boolean;
    config: Record<string, string>;
    credentials: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    lastTestedAt?: string;
}

export interface PublicProviderConnection {
    id: string;
    provider: ProviderId;
    name: string;
    enabled: boolean;
    isDefault: boolean;
    config: Record<string, string>;
    credentialKeys: string[];
    createdAt: string;
    updatedAt: string;
    lastTestedAt?: string;
}

const STORE_VERSION = 2;
const STORE_FILE = path.join(STORAGE_ROOT, "provider-connections.enc.json");
async function requireEncryptionKey(version = STORE_VERSION): Promise<Buffer> {
    if (version === 2) return vaultKey();
    const secret = process.env.OPEN_HIGGSFIELD_CREDENTIALS_KEY || process.env.OPEN_HIGGSFIELD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
    if (!secret) throw new Error("ERR_LEGACY_VAULT_KEY_REQUIRED");
    return crypto.scryptSync(secret, "open-higgsfield-provider-connections-v1", 32);
}

function randomId(): string {
    return crypto.randomUUID();
}

async function readConnections(): Promise<ProviderConnection[]> {
    try {
        const raw = await fs.readFile(STORE_FILE, "utf8");
        const envelope = JSON.parse(raw) as {
            version: number;
            iv: string;
            tag: string;
            ciphertext: string;
        };
        if (![1, STORE_VERSION].includes(envelope.version)) throw new Error("ERR_CONNECTION_STORE_VERSION");

        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            await requireEncryptionKey(envelope.version),
            Buffer.from(envelope.iv, "base64")
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
        ]).toString("utf8");
        const parsed = JSON.parse(plaintext) as { connections?: ProviderConnection[] };
        return Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") return [];
        if (error instanceof Error && error.message.startsWith("ERR_")) throw error;
        throw new Error("ERR_CONNECTION_STORE_UNREADABLE");
    }
}

async function writeConnections(connections: ProviderConnection[]): Promise<void> {
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", await requireEncryptionKey(), iv);
    const plaintext = JSON.stringify({ version: STORE_VERSION, connections });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = {
        version: STORE_VERSION,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
    };
    await atomicJson(STORE_FILE, envelope);
}

export function publicConnection(connection: ProviderConnection): PublicProviderConnection {
    return {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        enabled: connection.enabled,
        isDefault: connection.isDefault,
        config: connection.config,
        credentialKeys: Object.keys(connection.credentials),
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
        lastTestedAt: connection.lastTestedAt,
    };
}

export async function listProviderConnections(): Promise<PublicProviderConnection[]> {
    return (await readConnections()).map(publicConnection);
}

export async function getStoredConnection(id: string): Promise<ProviderConnection | undefined> {
    return (await readConnections()).find((connection) => connection.id === id);
}

export async function getStoredConnections(provider?: ProviderId): Promise<ProviderConnection[]> {
    const connections = await readConnections();
    return provider ? connections.filter((connection) => connection.provider === provider) : connections;
}

export async function markConnectionTested(candidate: ProviderConnection): Promise<void> {
    await withSecurityLock("connections", async () => {
        const connections = await readConnections();
        const connection = connections.find((item) => item.id === candidate.id);
        if (!connection || JSON.stringify(connection.credentials) !== JSON.stringify(candidate.credentials) || JSON.stringify(connection.config) !== JSON.stringify(candidate.config)) return;
        connection.lastTestedAt = new Date().toISOString();
        await writeConnections(connections);
    });
}

function envConnection(provider: ProviderId): ProviderConnection | undefined {
    const now = new Date().toISOString();
    if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
        return {
            id: "env:openrouter",
            provider,
            name: "OpenRouter (.env.local)",
            enabled: true,
            isDefault: false,
            config: {
                baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
                httpReferer: process.env.OPENROUTER_HTTP_REFERER || "",
                appTitle: process.env.OPENROUTER_APP_TITLE || "Open-Higgsfield",
            },
            credentials: { apiKey: process.env.OPENROUTER_API_KEY },
            createdAt: now,
            updatedAt: now,
        };
    }
    if (provider === "higgsfield" && (process.env.HIGGSFIELD_API_KEY || process.env.HF_CREDENTIALS)) {
        return {
            id: "env:higgsfield",
            provider,
            name: "Higgsfield (.env.local)",
            enabled: true,
            isDefault: false,
            config: { baseUrl: process.env.HIGGSFIELD_BASE_URL || "https://api.higgsfield.ai" },
            credentials: { apiKey: process.env.HIGGSFIELD_API_KEY || process.env.HF_CREDENTIALS || "" },
            createdAt: now,
            updatedAt: now,
        };
    }
    if (provider === "api-market" && process.env.API_MARKET_API_KEY) {
        return {
            id: "env:api-market",
            provider,
            name: "API.market (.env.local)",
            enabled: true,
            isDefault: false,
            config: {
                baseUrl: process.env.API_MARKET_BASE_URL || "https://prod.api.market/api/mcp",
                workspace: process.env.API_MARKET_WORKSPACE || "",
                slug: process.env.API_MARKET_SLUG || "",
                mediaType: process.env.API_MARKET_MEDIA_TYPE || "image",
                toolName: process.env.API_MARKET_TOOL_NAME || "",
            },
            credentials: { apiKey: process.env.API_MARKET_API_KEY },
            createdAt: now,
            updatedAt: now,
        };
    }
    return undefined;
}

export async function getConnectionForProvider(
    provider: ProviderId,
    connectionId?: string
): Promise<ProviderConnection | undefined> {
    if (connectionId) {
        const stored = connectionId.startsWith("env:") ? envConnection(provider) : await getStoredConnection(connectionId);
        if (stored?.enabled && stored.provider === provider && stored.id === connectionId) return stored;
        throw new Error("ERR_CONNECTION_NOT_FOUND");
    }

    const connections = await readConnections();
    const selected = connections.find((connection) =>
        connection.provider === provider && connection.enabled && connection.isDefault
    ) ?? connections.find((connection) => connection.provider === provider && connection.enabled);
    return selected ?? envConnection(provider);
}

export async function upsertProviderConnection(input: {
    id?: string;
    provider: ProviderId;
    name: string;
    config?: Record<string, string>;
    credentials: Record<string, string>;
    enabled?: boolean;
    isDefault?: boolean;
}): Promise<PublicProviderConnection> {
    return withSecurityLock("connections", async () => {
    const connections = await readConnections();
    const now = new Date().toISOString();
    const existingIndex = input.id ? connections.findIndex((connection) => connection.id === input.id) : -1;
    const current = existingIndex >= 0 ? connections[existingIndex] : undefined;
    if (input.id && !current) throw new Error("ERR_CONNECTION_NOT_FOUND");
    if (current && current.provider !== input.provider) throw new Error("ERR_CONNECTION_PROVIDER_MISMATCH");
    const connection: ProviderConnection = {
        id: current?.id ?? randomId(),
        provider: input.provider,
        name: input.name.trim() || input.provider,
        enabled: input.enabled ?? current?.enabled ?? true,
        isDefault: input.isDefault ?? current?.isDefault ?? false,
        config: { ...(current?.config ?? {}), ...(input.config ?? {}) },
        credentials: { ...(current?.credentials ?? {}), ...input.credentials },
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        lastTestedAt: current && JSON.stringify({ ...current.credentials, ...input.credentials }) === JSON.stringify(current.credentials) && JSON.stringify({ ...current.config, ...input.config }) === JSON.stringify(current.config) ? current.lastTestedAt : undefined,
    };

    if (connection.isDefault) {
        for (const other of connections) {
            if (other.provider === connection.provider) other.isDefault = false;
        }
    }
    if (existingIndex >= 0) connections[existingIndex] = connection;
    else connections.push(connection);
    await writeConnections(connections);
    return publicConnection(connection);
    });
}

export async function deleteProviderConnection(id: string): Promise<void> {
    return withSecurityLock("connections", async () => {
    const connections = await readConnections();
    const filtered = connections.filter((connection) => connection.id !== id);
    if (filtered.length !== connections.length) await writeConnections(filtered);
    });
}
