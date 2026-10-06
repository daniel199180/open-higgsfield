import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { STORAGE_ROOT } from "@/lib/storage-paths";
import type { GenerationUsage, UsageRecord, UsageGroup } from "./types";

// Independent of gallery deletion. The same schema works with the workflow worker's PostgreSQL.
const schema = `CREATE TABLE IF NOT EXISTS generation_usage (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, connection TEXT NOT NULL, model TEXT NOT NULL,
 label TEXT NOT NULL, media TEXT NOT NULL, source TEXT NOT NULL, created TEXT NOT NULL, status TEXT NOT NULL,
 input_tokens DOUBLE PRECISION, output_tokens DOUBLE PRECISION, total_tokens DOUBLE PRECISION, cost_usd DOUBLE PRECISION,
 estimate_min DOUBLE PRECISION, estimate_max DOUBLE PRECISION
); CREATE TABLE IF NOT EXISTS generation_rates (id TEXT PRIMARY KEY, usd DOUBLE PRECISION NOT NULL);`;
type Sql = (query: string, params?: (string | number | null)[]) => Promise<Record<string, unknown>[]>;
export function createBillingStore(sql: Sql) {
    return {
        async begin(record: UsageRecord) {
            await sql(`INSERT INTO generation_usage (id,provider,connection,model,label,media,source,created,status,estimate_min,estimate_max) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
                [record.id, record.provider, record.connection, record.model, record.label, record.media, record.source, record.created, record.status, record.estimateMin ?? null, record.estimateMax ?? null]);
        },
        async update(id: string, status: string, usage?: GenerationUsage) {
            // Polling returns cumulative usage: replace known fields, NEVER increment them.
            await sql(`UPDATE generation_usage SET status=?, input_tokens=COALESCE(?,input_tokens), output_tokens=COALESCE(?,output_tokens), total_tokens=COALESCE(?,total_tokens), cost_usd=COALESCE(?,cost_usd) WHERE id=?`,
                [status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, usage?.costUsd ?? null, id]);
        },
        async summary() {
            const rows = await sql(`SELECT provider,connection,model,MAX(label) AS label,COUNT(*) AS requests,
                SUM(cost_usd) AS cost, SUM(total_tokens) AS tokens, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                COUNT(cost_usd) AS cost_known, COUNT(total_tokens) AS tokens_known,
                SUM(CASE WHEN cost_usd IS NULL AND status='COMPLETED' THEN estimate_min END) AS est_min,
                SUM(CASE WHEN cost_usd IS NULL AND status='COMPLETED' THEN estimate_max END) AS est_max,
                COUNT(CASE WHEN cost_usd IS NULL AND status='COMPLETED' THEN estimate_min END) AS estimated
                FROM generation_usage GROUP BY provider,connection,model ORDER BY provider,connection,model`);
            const nullable = (v: unknown) => v == null ? null : Number(v);
            const groups: UsageGroup[] = rows.map(r => ({ provider: String(r.provider), connection: String(r.connection), model: String(r.model), label: String(r.label), requests: Number(r.requests), costUsd: nullable(r.cost), totalTokens: nullable(r.tokens), inputTokens: nullable(r.input), outputTokens: nullable(r.output), costKnown: Number(r.cost_known), tokensKnown: Number(r.tokens_known), estimateMin: nullable(r.est_min), estimateMax: nullable(r.est_max), estimated: Number(r.estimated) }));
            const recent = (await sql("SELECT * FROM generation_usage ORDER BY created DESC LIMIT 50")).map(r => ({ id: r.id, provider: r.provider, connection: r.connection, model: r.model, label: r.label, media: r.media, source: r.source, created: r.created, status: r.status, inputTokens: nullable(r.input_tokens), outputTokens: nullable(r.output_tokens), totalTokens: nullable(r.total_tokens), costUsd: nullable(r.cost_usd), estimateMin: nullable(r.estimate_min), estimateMax: nullable(r.estimate_max) }));
            return { groups, recent };
        },
        async rate(key: string): Promise<number | undefined> {
            const rows = await sql("SELECT usd FROM generation_rates WHERE id=?", [key]);
            return rows.length ? Number(rows[0].usd) : undefined;
        },
        async setRate(key: string, usd: number | null) {
            if (usd === null) await sql("DELETE FROM generation_rates WHERE id=?", [key]);
            else await sql("INSERT INTO generation_rates (id,usd) VALUES (?,?) ON CONFLICT (id) DO UPDATE SET usd=excluded.usd", [key, usd]);
        },
    };
}
export function createSqliteBillingStore(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    db.exec(schema);
    return createBillingStore(async (query, params = []) => db.prepare(query).all(...params) as Record<string, unknown>[]);
}
function createPostgresBillingStore(connectionString: string) {
    const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000 });
    let ready: Promise<unknown> | undefined;
    return createBillingStore(async (query, params = []) => {
        await (ready ??= pool.query(schema).catch(error => { ready = undefined; throw error; }));
        let index = 0;
        return (await pool.query(query.replace(/\?/g, () => `$${++index}`), params)).rows;
    });
}
const shared = globalThis as typeof globalThis & { __billingStore?: ReturnType<typeof createBillingStore> };
export function billingStore() {
    if (process.env.VERCEL && !process.env.WORKFLOWS_DATABASE_URL) throw new Error("ERR_PERSISTENT_STORAGE_REQUIRED");
    return shared.__billingStore ??= process.env.WORKFLOWS_DATABASE_URL
        ? createPostgresBillingStore(process.env.WORKFLOWS_DATABASE_URL)
        : createSqliteBillingStore(path.join(STORAGE_ROOT, "billing", "usage.sqlite"));
}
