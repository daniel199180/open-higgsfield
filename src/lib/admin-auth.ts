import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { atomicJson, readJson, SECURITY_DIR, withSecurityLock, vaultKey } from "./security-store";

export const COOKIE_NAME = "open_higgsfield_admin";
export const COOKIE_MAX_AGE = 60 * 60 * 8;
const STATE_FILE = path.join(SECURITY_DIR, "admin.json");
interface AuthState {
    version: 1;
    password?: { salt: string; hash: string };
    recoveryHash?: string;
    setup?: { hash: string; expires: number };
    sessions: { hash: string; expires: number }[];
    limits: Record<string, { count: number; until: number }>;
    audit: { event: string; at: string }[];
}
const emptyState = (): AuthState => ({ version: 1, sessions: [], limits: {}, audit: [] });
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function equal(a: string, b: string) {
    const aa = Buffer.from(a); const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
async function state() {
    const value = await readJson<AuthState>(STATE_FILE);
    if (value && (value.version !== 1 || !Array.isArray(value.sessions) || !value.limits)) throw new Error("ERR_AUTH_STORE_INVALID");
    return value ?? emptyState();
}
async function update<T>(fn: (value: AuthState) => Promise<T> | T): Promise<T> {
    return withSecurityLock("auth", async () => {
        const value = await state();
        const result = await fn(value);
        await atomicJson(STATE_FILE, value);
        return result;
    });
}
function audit(value: AuthState, event: string) {
    value.audit = [...value.audit.slice(-199), { event, at: new Date().toISOString() }];
}
export async function recordSecurityEvent(event: string) { await update((value) => audit(value, event)); }

export async function takeRateLimit(bucket: string, maximum: number, windowMs: number) {
    return update((value) => {
        const now = Date.now();
        for (const key of Object.keys(value.limits)) if (value.limits[key].until <= now) delete value.limits[key];
        const limit = value.limits[bucket] ?? { count: 0, until: now + windowMs };
        value.limits[bucket] = limit;
        if (limit.count >= maximum) return false;
        limit.count++;
        return true;
    });
}

function derive(password: string, salt: string): Promise<Buffer> {
    // OWASP scrypt baseline: N=2^17, r=8, p=1 (~128 MiB); async, bounded by auth rate limits.
    return new Promise((resolve, reject) => crypto.scrypt(password, salt, 32,
        { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key)));
}
export function validatePassword(password: unknown): asserts password is string {
    if (typeof password !== "string" || password.length < 15 || password.length > 128) throw new Error("ERR_PASSWORD_LENGTH");
}
async function passwordHash(password: string) {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: (await derive(password, salt)).toString("hex") };
}
function session(value: AuthState) {
    const token = crypto.randomBytes(32).toString("base64url");
    value.sessions = value.sessions.filter((item) => item.expires > Date.now()).slice(-9);
    value.sessions.push({ hash: digest(token), expires: Date.now() + COOKIE_MAX_AGE * 1000 });
    return token;
}
function recovery(value: AuthState) {
    const code = crypto.randomBytes(24).toString("base64url");
    value.recoveryHash = digest(code);
    return code;
}
export async function isAdminConfigured() { return Boolean((await state()).password); }
export async function verifyAdminSession(token?: string | null) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const value = await state();
    return Boolean(value.password && value.sessions.some((item) => item.expires > Date.now() && equal(item.hash, digest(token))));
}
export async function initializeAdminSetup(): Promise<void> {
    if (await isAdminConfigured()) return;
    await vaultKey();
    const token = process.env.OPEN_HIGGSFIELD_SETUP_TOKEN || crypto.randomBytes(24).toString("base64url");
    if (token.length < 24) throw new Error("ERR_SETUP_TOKEN_TOO_SHORT");
    const created = await update((value) => {
        if (value.password) return false;
        value.setup = { hash: digest(token), expires: Date.now() + 30 * 60 * 1000 };
        return true;
    });
    // Intentional one-time bootstrap delivery to the server operator only.
    // API keys, passwords, recovery codes and session tokens are never logged.
    if (created && !process.env.OPEN_HIGGSFIELD_SETUP_TOKEN) console.info(`\nOpen-Higgsfield — código de instalación (30 minutos): ${token}\nAbre la aplicación y crea tu administrador.\n`);
}
export async function createAdmin(password: string, setupToken: string) {
    validatePassword(password);
    return update(async (value) => {
        if (value.password) throw new Error("ERR_ADMIN_ALREADY_CONFIGURED");
        if (!value.setup || value.setup.expires < Date.now() || !equal(value.setup.hash, digest(setupToken))) throw new Error("ERR_SETUP_TOKEN_INVALID");
        value.password = await passwordHash(password);
        delete value.setup;
        audit(value, "admin.created");
        return { token: session(value), recoveryCode: recovery(value) };
    });
}
export async function loginAdmin(password: string) {
    return update(async (value) => {
        if (!value.password || !equal(value.password.hash, (await derive(password, value.password.salt)).toString("hex"))) return undefined;
        audit(value, "admin.login");
        return session(value);
    });
}
export async function logoutAdmin(token: string, all = false) {
    await update((value) => {
        value.sessions = all ? [] : value.sessions.filter((item) => !equal(item.hash, digest(token)));
        audit(value, all ? "sessions.revoked" : "admin.logout");
    });
}
export async function changeAdminPassword(password: string, proof: string, mode: "password" | "recovery") {
    validatePassword(password);
    return update(async (value) => {
        const valid = mode === "recovery"
            ? value.recoveryHash && equal(value.recoveryHash, digest(proof))
            : value.password && equal(value.password.hash, (await derive(proof, value.password.salt)).toString("hex"));
        if (!valid) throw new Error("ERR_ADMIN_AUTH_FAILED");
        value.password = await passwordHash(password);
        value.sessions = [];
        audit(value, mode === "recovery" ? "admin.recovered" : "admin.password_changed");
        return { token: session(value), recoveryCode: recovery(value) };
    });
}
