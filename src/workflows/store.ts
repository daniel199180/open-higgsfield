import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { STORAGE_ROOT } from "@/lib/storage-paths";
import type { Workflow, WorkflowRun, Asset } from "./types";

export const WORKFLOW_DIR = path.join(STORAGE_ROOT, "workflows");
type Document = Workflow | WorkflowRun | Asset;
export type Documents = Map<string, Document>;
type Store = { transaction<T>(fn: (docs: Documents) => T): Promise<T>; read<T extends Document>(key: string): Promise<T | undefined>; list<T extends Document>(prefix: string): Promise<T[]> };

// Transactions never contain network calls. SQLite coordinates processes locally;
// PostgreSQL serializes short updates across web and worker containers.
export function createSqliteStore(filename: string): Store {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workflow_documents (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    return {
        async transaction(fn) {
            db.exec("BEGIN IMMEDIATE");
            try {
                const rows = db.prepare("SELECT id, payload FROM workflow_documents").all() as { id: string; payload: string }[];
                const original = new Map(rows.map(row => [row.id, row.payload]));
                const docs: Documents = new Map(rows.map(row => [row.id, JSON.parse(row.payload)]));
                const result = fn(docs);
                for (const [id, value] of docs) {
                    const payload = JSON.stringify(value);
                    if (original.get(id) !== payload) db.prepare("INSERT INTO workflow_documents (id, payload) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET payload=excluded.payload").run(id, payload);
                }
                db.exec("COMMIT");
                return structuredClone(result);
            } catch (error) { db.exec("ROLLBACK"); throw error; }
        },
        async read<T>(key: string) {
            const row = db.prepare("SELECT payload FROM workflow_documents WHERE id=?").get(key) as { payload: string } | undefined;
            return row ? JSON.parse(row.payload) as T : undefined;
        },
        async list<T>(prefix: string) {
            const rows = db.prepare("SELECT payload FROM workflow_documents WHERE id LIKE ? ORDER BY rowid DESC LIMIT 1000").all(`${prefix}%`) as { payload: string }[];
            return rows.map(row => JSON.parse(row.payload) as T);
        },
    };
}

export function createPostgresStore(connectionString: string): Store {
    const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
    let schema: Promise<unknown> | undefined;
    const ready = () => schema ??= pool.query("CREATE TABLE IF NOT EXISTS workflow_documents (id TEXT PRIMARY KEY, payload TEXT NOT NULL)").catch(error => { schema = undefined; throw error; });
    return {
        async transaction(fn) {
            await ready();
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query("SELECT pg_advisory_xact_lock(84629131)");
                const { rows } = await client.query("SELECT id, payload FROM workflow_documents");
                const original = new Map(rows.map(row => [row.id, row.payload]));
                const docs: Documents = new Map(rows.map(row => [row.id, JSON.parse(row.payload)]));
                const result = fn(docs);
                for (const [id, value] of docs) {
                    const payload = JSON.stringify(value);
                    if (original.get(id) !== payload) await client.query("INSERT INTO workflow_documents (id,payload) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET payload=excluded.payload", [id, payload]);
                }
                await client.query("COMMIT");
                return structuredClone(result);
            } catch (error) { await client.query("ROLLBACK"); throw error; }
            finally { client.release(); }
        },
        async read<T>(key: string) {
            await ready();
            const { rows } = await pool.query("SELECT payload FROM workflow_documents WHERE id=$1", [key]);
            return rows[0] ? JSON.parse(rows[0].payload) as T : undefined;
        },
        async list<T>(prefix: string) {
            await ready();
            const { rows } = await pool.query("SELECT payload FROM workflow_documents WHERE id LIKE $1 LIMIT 1000", [`${prefix}%`]);
            return rows.map(row => JSON.parse(row.payload) as T);
        },
    };
}
const globalStore = globalThis as typeof globalThis & { __workflowStore?: Store };
export function workflowStore(): Store {
    if (process.env.VERCEL) throw new Error("ERR_PERSISTENT_STORAGE_REQUIRED");
    return globalStore.__workflowStore ??= process.env.WORKFLOWS_DATABASE_URL
        ? createPostgresStore(process.env.WORKFLOWS_DATABASE_URL)
        : createSqliteStore(path.join(WORKFLOW_DIR, "workflows.sqlite"));
}
