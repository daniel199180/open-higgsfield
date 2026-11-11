import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { atomicJson, readJson, SECURITY_DIR, withSecurityLock } from "@/lib/security-store";

export interface McpServerConfig {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    connectionId: string;
    imageModelIds: string[];
    videoModelIds: string[];
    tokenHash: string;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string;
}

export type PublicMcpServerConfig = Omit<McpServerConfig, "tokenHash">;

interface McpServerFile {
    version: 1;
    servers: McpServerConfig[];
}

const STORE_FILE = path.join(SECURITY_DIR, "mcp-servers.json");

function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function createToken(): string {
    return `ohf_mcp_${crypto.randomBytes(32).toString("base64url")}`;
}

async function readStore(): Promise<McpServerFile> {
    const value = await readJson<McpServerFile>(STORE_FILE);
    if (!value) return { version: 1, servers: [] };
    if (value.version !== 1 || !Array.isArray(value.servers)) throw new Error("ERR_MCP_STORE_INVALID");
    return value;
}

function publicServer(server: McpServerConfig): PublicMcpServerConfig {
    const { tokenHash: _tokenHash, ...safe } = server;
    void _tokenHash;
    return safe;
}

export async function listMcpServers(): Promise<PublicMcpServerConfig[]> {
    return (await readStore()).servers.map(publicServer);
}

export async function getMcpServer(id: string): Promise<McpServerConfig | undefined> {
    return (await readStore()).servers.find((server) => server.id === id);
}

export async function createMcpServer(input: {
    name: string;
    description: string;
    enabled: boolean;
    connectionId: string;
    imageModelIds: string[];
    videoModelIds: string[];
}): Promise<{ server: PublicMcpServerConfig; token: string }> {
    return withSecurityLock("mcp-servers", async () => {
        const store = await readStore();
        const token = createToken();
        const now = new Date().toISOString();
        const server: McpServerConfig = {
            id: crypto.randomUUID(),
            ...input,
            tokenHash: hashToken(token),
            createdAt: now,
            updatedAt: now,
        };
        store.servers.push(server);
        await atomicJson(STORE_FILE, store);
        return { server: publicServer(server), token };
    });
}

export async function updateMcpServer(id: string, input: {
    name: string;
    description: string;
    enabled: boolean;
    connectionId: string;
    imageModelIds: string[];
    videoModelIds: string[];
    rotateToken?: boolean;
}): Promise<{ server: PublicMcpServerConfig; token?: string }> {
    return withSecurityLock("mcp-servers", async () => {
        const store = await readStore();
        const index = store.servers.findIndex((server) => server.id === id);
        if (index < 0) throw new Error("ERR_MCP_SERVER_NOT_FOUND");
        const token = input.rotateToken ? createToken() : undefined;
        const { rotateToken: _rotateToken, ...values } = input;
        void _rotateToken;
        const updated: McpServerConfig = {
            ...store.servers[index],
            ...values,
            ...(token ? { tokenHash: hashToken(token) } : {}),
            updatedAt: new Date().toISOString(),
        };
        store.servers[index] = updated;
        await atomicJson(STORE_FILE, store);
        return { server: publicServer(updated), token };
    });
}

export async function deleteMcpServer(id: string): Promise<void> {
    await withSecurityLock("mcp-servers", async () => {
        const store = await readStore();
        const remaining = store.servers.filter((server) => server.id !== id);
        if (remaining.length === store.servers.length) throw new Error("ERR_MCP_SERVER_NOT_FOUND");
        await atomicJson(STORE_FILE, { ...store, servers: remaining });
    });
}

export async function authenticateMcpServer(id: string, token: string): Promise<McpServerConfig | undefined> {
    if (!token || token.length > 200) return;
    const server = await getMcpServer(id);
    if (!server?.enabled) return;
    const expected = Buffer.from(server.tokenHash, "hex");
    const actual = Buffer.from(hashToken(token), "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return;
    return server;
}

export async function touchMcpServer(id: string): Promise<void> {
    await withSecurityLock("mcp-servers", async () => {
        const store = await readStore();
        const server = store.servers.find((item) => item.id === id);
        if (!server) return;
        server.lastUsedAt = new Date().toISOString();
        await atomicJson(STORE_FILE, store);
    });
}
