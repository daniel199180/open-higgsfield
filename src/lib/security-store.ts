import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { STORAGE_ROOT } from "./storage-paths";

export const SECURITY_DIR = path.join(STORAGE_ROOT, ".higgsfield-security");

export async function privateDirectory() {
    if (process.env.VERCEL) throw new Error("ERR_PERSISTENT_STORAGE_REQUIRED");
    await fs.mkdir(SECURITY_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(SECURITY_DIR, 0o700);
}

export async function atomicJson(file: string, data: unknown) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
}

// A filesystem lock also covers Next.js workers. A crash leaves a fail-closed lock;
// remove it only with the service stopped, never steal a possibly live lock.
export async function withSecurityLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await privateDirectory();
    const lock = path.join(SECURITY_DIR, `${name}.lock`);
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    if (!acquired) throw new Error("ERR_SECURITY_STORE_BUSY");
    try { return await action(); } finally { await fs.rmdir(lock); }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function vaultKey(): Promise<Buffer> {
    return withSecurityLock("key", async () => {
        const file = path.join(SECURITY_DIR, "master-key.json");
        let key = await readJson<{ key: string }>(file);
        if (!key) {
            // Never replace a missing key when encrypted data already exists.
            const existing = await fs.stat(path.join(STORAGE_ROOT, "provider-connections.enc.json")).catch(() => undefined);
            if (existing) {
                const envelope = await readJson<{ version: number }>(path.join(STORAGE_ROOT, "provider-connections.enc.json"));
                if (envelope?.version !== 1) throw new Error("ERR_VAULT_KEY_MISSING");
            }
            key = { key: crypto.randomBytes(32).toString("base64") };
            await atomicJson(file, key);
        }
        const bytes = Buffer.from(key.key, "base64");
        if (bytes.length !== 32) throw new Error("ERR_VAULT_KEY_INVALID");
        return bytes;
    });
}
