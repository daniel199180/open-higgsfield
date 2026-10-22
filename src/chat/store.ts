import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { databaseClient } from "@/lib/database";
import { STORAGE_ROOT } from "@/lib/storage-paths";
import { atomicJson, readJson, withSecurityLock } from "@/lib/security-store";
import type { ChatMessage, ChatRole, ChatSession, ChatSessionDetail } from "./types";

const CHAT_FILE = path.join(STORAGE_ROOT, "chat_history.json");
const MAX_SESSIONS = 200;
const MAX_MESSAGES_PER_SESSION = 500;

interface ChatSnapshot {
    sessions: ChatSession[];
    messages: ChatMessage[];
}

function emptySnapshot(): ChatSnapshot {
    return { sessions: [], messages: [] };
}

async function readSnapshot(): Promise<ChatSnapshot> {
    const snapshot = await readJson<ChatSnapshot>(CHAT_FILE);
    if (!snapshot || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.messages)) return emptySnapshot();
    return snapshot;
}

async function writeSnapshot(snapshot: ChatSnapshot): Promise<void> {
    await atomicJson(CHAT_FILE, snapshot);
}

function publicSession(session: ChatSession, messages: ChatMessage[] = []): ChatSession {
    return { ...session, messageCount: messages.length || session.messageCount || 0 };
}

function sessionFromRow(row: Record<string, unknown>, messageCount: number): ChatSession {
    return {
        id: String(row.id),
        title: String(row.title),
        modelId: typeof row.model_id === "string" && row.model_id ? row.model_id : undefined,
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
        messageCount,
        webSearch: row.web_search === true,
        reasoning: row.reasoning === true,
        skillId: typeof row.skill_id === "string" && row.skill_id ? row.skill_id : undefined,
    };
}

function messageFromRow(row: Record<string, unknown>): ChatMessage {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        role: row.role === "assistant" ? "assistant" : "user",
        content: String(row.content),
        modelId: typeof row.model_id === "string" && row.model_id ? row.model_id : undefined,
        sources: parseSources(row.sources_json),
        attachmentNames: parseNames(row.attachment_names_json),
        createdAt: new Date(String(row.created_at)).toISOString(),
    };
}

function parseSources(value: unknown): ChatMessage["sources"] {
    if (typeof value !== "string") return undefined;
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; }
}

function parseNames(value: unknown): string[] | undefined {
    if (typeof value !== "string") return undefined;
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined; } catch { return undefined; }
}

export async function listChatSessions(): Promise<ChatSession[]> {
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`
            SELECT s.id, s.title, s.model_id, s.created_at, s.updated_at, s.web_search, s.reasoning, s.skill_id,
                   COUNT(m.id)::int AS message_count
            FROM chat_sessions s
            LEFT JOIN chat_messages m ON m.session_id = s.id
            WHERE s.archived_at IS NULL
            GROUP BY s.id
            ORDER BY s.updated_at DESC
            LIMIT ${MAX_SESSIONS}
        `;
        return rows.map((row) => sessionFromRow(row as Record<string, unknown>, Number(row.message_count ?? 0)));
    }
    const snapshot = await readSnapshot();
    return snapshot.sessions
        .filter((session) => !session.archivedAt)
        .map((session) => publicSession(session, snapshot.messages.filter((message) => message.sessionId === session.id)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_SESSIONS);
}

export async function getChatSession(id: string): Promise<ChatSessionDetail | null> {
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`
            SELECT id, title, model_id, created_at, updated_at, web_search, reasoning, skill_id,
                   (SELECT COUNT(*)::int FROM chat_messages WHERE session_id = chat_sessions.id) AS message_count
            FROM chat_sessions
            WHERE id = ${id} AND archived_at IS NULL
            LIMIT 1
        `;
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        const messages = await sql`
            SELECT id, session_id, role, content, model_id, sources_json, attachment_names_json, created_at
            FROM chat_messages
            WHERE session_id = ${id}
            ORDER BY created_at ASC, id ASC
            LIMIT ${MAX_MESSAGES_PER_SESSION}
        `;
        return { ...sessionFromRow(row, Number(row.message_count ?? 0)), messages: messages.map((item) => messageFromRow(item as Record<string, unknown>)) };
    }
    const snapshot = await readSnapshot();
    const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
    if (!session) return null;
    const messages = snapshot.messages.filter((message) => message.sessionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, MAX_MESSAGES_PER_SESSION);
    return { ...publicSession(session, messages), messages };
}

export async function createChatSession(modelId?: string, settings?: Pick<ChatSession, "webSearch" | "reasoning" | "skillId">): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = { id: crypto.randomUUID(), title: "Nueva conversación", modelId: modelId || undefined, createdAt: now, updatedAt: now, messageCount: 0, webSearch: settings?.webSearch ?? false, reasoning: settings?.reasoning ?? false, skillId: settings?.skillId };
    const sql = await databaseClient();
    if (sql) {
        await sql`
            INSERT INTO chat_sessions (id, title, model_id, created_at, updated_at, web_search, reasoning, skill_id)
            VALUES (${session.id}, ${session.title}, ${session.modelId ?? null}, ${session.createdAt}, ${session.updatedAt}, ${session.webSearch}, ${session.reasoning}, ${session.skillId ?? null})
        `;
        return session;
    }
    await withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        snapshot.sessions.unshift(session);
        snapshot.sessions = snapshot.sessions.slice(0, MAX_SESSIONS);
        await writeSnapshot(snapshot);
    });
    return session;
}

export async function renameChatSession(id: string, title: string): Promise<ChatSession | null> {
    const cleanTitle = title.trim().slice(0, 120);
    if (!cleanTitle) return null;
    const now = new Date().toISOString();
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`
            UPDATE chat_sessions SET title = ${cleanTitle}, updated_at = ${now}
            WHERE id = ${id} AND archived_at IS NULL
            RETURNING id, title, model_id, created_at, updated_at
        `;
        if (!rows[0]) return null;
        const count = await sql`SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = ${id}`;
        return sessionFromRow(rows[0] as Record<string, unknown>, Number(count[0]?.count ?? 0));
    }
    return withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
        if (!session) return null;
        session.title = cleanTitle;
        session.updatedAt = now;
        await writeSnapshot(snapshot);
        return publicSession(session, snapshot.messages.filter((message) => message.sessionId === id));
    });
}

export async function updateChatSessionModel(id: string, modelId: string): Promise<ChatSession | null> {
    const now = new Date().toISOString();
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`
            UPDATE chat_sessions SET model_id = ${modelId || null}, updated_at = ${now}
            WHERE id = ${id} AND archived_at IS NULL
            RETURNING id, title, model_id, created_at, updated_at
        `;
        if (!rows[0]) return null;
        const count = await sql`SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = ${id}`;
        return sessionFromRow(rows[0] as Record<string, unknown>, Number(count[0]?.count ?? 0));
    }
    return withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
        if (!session) return null;
        session.modelId = modelId || undefined;
        session.updatedAt = now;
        await writeSnapshot(snapshot);
        return publicSession(session, snapshot.messages.filter((message) => message.sessionId === id));
    });
}

export async function updateChatSessionSettings(id: string, settings: Partial<Pick<ChatSession, "webSearch" | "reasoning" | "skillId">>): Promise<ChatSession | null> {
    const now = new Date().toISOString();
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`
            UPDATE chat_sessions
            SET web_search = COALESCE(${settings.webSearch ?? null}, web_search),
                reasoning = COALESCE(${settings.reasoning ?? null}, reasoning),
                skill_id = COALESCE(${settings.skillId ?? null}, skill_id),
                updated_at = ${now}
            WHERE id = ${id} AND archived_at IS NULL
            RETURNING id, title, model_id, created_at, updated_at, web_search, reasoning, skill_id
        `;
        if (!rows[0]) return null;
        const count = await sql`SELECT COUNT(*)::int AS count FROM chat_messages WHERE session_id = ${id}`;
        return sessionFromRow(rows[0] as Record<string, unknown>, Number(count[0]?.count ?? 0));
    }
    return withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
        if (!session) return null;
        if (settings.webSearch !== undefined) session.webSearch = settings.webSearch;
        if (settings.reasoning !== undefined) session.reasoning = settings.reasoning;
        if (settings.skillId !== undefined) session.skillId = settings.skillId || undefined;
        session.updatedAt = now;
        await writeSnapshot(snapshot);
        return publicSession(session, snapshot.messages.filter((message) => message.sessionId === id));
    });
}

export async function appendChatMessage(input: { sessionId: string; role: ChatRole; content: string; modelId?: string; sources?: ChatMessage["sources"]; attachmentNames?: string[] }): Promise<ChatMessage | null> {
    const content = input.content.trim();
    if (!content) return null;
    const message: ChatMessage = { id: crypto.randomUUID(), sessionId: input.sessionId, role: input.role, content, modelId: input.modelId, sources: input.sources, attachmentNames: input.attachmentNames, createdAt: new Date().toISOString() };
    const sql = await databaseClient();
    if (sql) {
        const session = await sql`SELECT id FROM chat_sessions WHERE id = ${input.sessionId} AND archived_at IS NULL LIMIT 1`;
        if (!session[0]) return null;
        await sql`
            INSERT INTO chat_messages (id, session_id, role, content, model_id, sources_json, attachment_names_json, created_at)
            VALUES (${message.id}, ${message.sessionId}, ${message.role}, ${message.content}, ${message.modelId ?? null}, ${message.sources ? JSON.stringify(message.sources) : null}, ${message.attachmentNames ? JSON.stringify(message.attachmentNames) : null}, ${message.createdAt})
        `;
        await sql`UPDATE chat_sessions SET updated_at = ${message.createdAt} WHERE id = ${input.sessionId}`;
        return message;
    }
    return withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === input.sessionId && !item.archivedAt);
        if (!session) return null;
        snapshot.messages.push(message);
        const sessionMessages = snapshot.messages.filter((item) => item.sessionId === input.sessionId);
        if (input.role === "user" && session.title === "Nueva conversación") session.title = content.replace(/\s+/g, " ").slice(0, 64) || session.title;
        session.updatedAt = message.createdAt;
        if (sessionMessages.length > MAX_MESSAGES_PER_SESSION) {
            const keep = new Set(sessionMessages.slice(-MAX_MESSAGES_PER_SESSION).map((item) => item.id));
            snapshot.messages = snapshot.messages.filter((item) => item.sessionId !== input.sessionId || keep.has(item.id));
        }
        await writeSnapshot(snapshot);
        return message;
    });
}

export async function touchChatSession(id: string, title?: string): Promise<void> {
    const now = new Date().toISOString();
    const sql = await databaseClient();
    if (sql) {
        if (title) await sql`UPDATE chat_sessions SET title = ${title.slice(0, 120)}, updated_at = ${now} WHERE id = ${id} AND archived_at IS NULL`;
        else await sql`UPDATE chat_sessions SET updated_at = ${now} WHERE id = ${id} AND archived_at IS NULL`;
        return;
    }
    await withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
        if (!session) return;
        if (title) session.title = title.slice(0, 120);
        session.updatedAt = now;
        await writeSnapshot(snapshot);
    });
}

export async function archiveChatSession(id: string): Promise<boolean> {
    const sql = await databaseClient();
    if (sql) {
        const rows = await sql`UPDATE chat_sessions SET archived_at = NOW() WHERE id = ${id} AND archived_at IS NULL RETURNING id`;
        return Boolean(rows[0]);
    }
    return withSecurityLock("chat-history", async () => {
        const snapshot = await readSnapshot();
        const session = snapshot.sessions.find((item) => item.id === id && !item.archivedAt);
        if (!session) return false;
        (session as ChatSession & { archivedAt?: string }).archivedAt = new Date().toISOString();
        await writeSnapshot(snapshot);
        return true;
    });
}
