import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

test("single-admin setup, encrypted connections and security boundaries", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgsfield-security-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    process.env.OPEN_HIGGSFIELD_SETUP_TOKEN = crypto.randomBytes(32).toString("hex");
    const auth = await import("../src/lib/admin-auth");
    const store = await import("../src/lib/connection-store");
    const { connectionSchema, validateConnectionConfig } = await import("../src/lib/connection-validation");
    const { providerUrl } = await import("../src/providers/secure-fetch");
    const { checkOrigin, readJsonBody } = await import("../src/lib/api-security");
    const { NextRequest } = await import("next/server");
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const password = "test-only-long-password-12345";
    let session = ""; let recovery = ""; let id = "";
    await t.test("setup is single-use, token protected and race safe", async () => {
        assert.equal(await auth.isAdminConfigured(), false);
        await auth.initializeAdminSetup();
        await assert.rejects(auth.createAdmin(password, "incorrect"), /ERR_SETUP_TOKEN_INVALID/);
        await assert.rejects(auth.createAdmin("short", process.env.OPEN_HIGGSFIELD_SETUP_TOKEN!), /ERR_PASSWORD_LENGTH/);
        const attempts = await Promise.allSettled([auth.createAdmin(password, process.env.OPEN_HIGGSFIELD_SETUP_TOKEN!), auth.createAdmin(password, process.env.OPEN_HIGGSFIELD_SETUP_TOKEN!)]);
        assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
        const result = attempts.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<{token: string; recoveryCode: string}>;
        session = result.value.token; recovery = result.value.recoveryCode;
        assert.equal(await auth.isAdminConfigured(), true);
        assert.equal(await auth.verifyAdminSession(session), true);
    });
    await t.test("passwords and opaque sessions never stored in clear text", async () => {
        const raw = await fs.readFile(path.join(directory, ".higgsfield-security/admin.json"), "utf8");
        for (const secret of [password, session, recovery, process.env.OPEN_HIGGSFIELD_SETUP_TOKEN!]) assert.equal(raw.includes(secret), false);
        assert.equal(await auth.loginAdmin("wrong"), undefined);
        assert.equal(await auth.verifyAdminSession(`${session}tampered`), false);
    });
    await t.test("credentials encrypted, public DTOs omit secrets, concurrent writes preserved", async () => {
        const apiKey = `test-key-${crypto.randomUUID()}`;
        const connections = await Promise.all(["one", "two"].map((name) => store.upsertProviderConnection({ provider: "openrouter", name, credentials: { apiKey }, isDefault: true })));
        id = connections[0].id;
        assert.equal((await store.listProviderConnections()).length, 2);
        assert.equal((await store.listProviderConnections()).filter((item) => item.isDefault).length, 1);
        assert.equal(JSON.stringify(connections).includes(apiKey), false);
        assert.equal((await fs.readFile(path.join(directory, "provider-connections.enc.json"), "utf8")).includes(apiKey), false);
        assert.equal((await store.getStoredConnection(id))?.credentials.apiKey, apiKey);
        assert.equal((await fs.stat(path.join(directory, "provider-connections.enc.json"))).mode & 0o777, 0o600);
    });
    await t.test("connections cannot cross providers or silently fall back after deletion", async () => {
        await assert.rejects(store.getConnectionForProvider("higgsfield", id), /ERR_CONNECTION_NOT_FOUND/);
        await assert.rejects(store.upsertProviderConnection({ id, provider: "higgsfield", name: "changed", credentials: {} }), /ERR_CONNECTION_PROVIDER_MISMATCH/);
        await store.upsertProviderConnection({ id, provider: "openrouter", name: "disabled", credentials: {}, enabled: false });
        await assert.rejects(store.getConnectionForProvider("openrouter", id), /ERR_CONNECTION_NOT_FOUND/);
    });
    await t.test("schema validation, official destinations and safe relative polling URLs", () => {
        assert.equal(connectionSchema.safeParse({ provider: "openrouter", name: "test", credentials: { apiKey: "abc\r\nInjected: yes" } }).success, false);
        assert.throws(() => validateConnectionConfig({ provider: "openrouter", name: "test", credentials: {}, config: { baseUrl: "https://evil.example" } }), /ERR_PROVIDER_URL_NOT_ALLOWED/);
        for (const url of ["http://127.0.0.1/", "https://openrouter.ai.evil.example/api/v1", "https://secret@openrouter.ai/api/v1", "https://openrouter.ai/api/v1/../../admin", "https://api.higgsfield.ai/"]) assert.throws(() => providerUrl("openrouter", url));
        assert.equal(providerUrl("openrouter", "/api/v1/videos/job123").href, "https://openrouter.ai/api/v1/videos/job123");
    });
    await t.test("CSRF and JSON size/type controls reject invalid requests", async () => {
        process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "http://localhost:3000";
        const request = (origin?: string) => new NextRequest("http://localhost:3000/api/admin/auth", { method: "POST", headers: origin ? { origin } : {} });
        assert.equal(checkOrigin(request("http://localhost:3000")), null);
        assert.equal(checkOrigin(request("https://evil.example"))?.status, 403);
        assert.equal(checkOrigin(request())?.status, 403);
        await assert.rejects(readJsonBody(new Request("https://example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "a".repeat(17000) }) })), /ERR_BODY_TOO_LARGE/);
    });
    await t.test("development accepts only matching loopback Host origins despite internal bind address", () => {
        const previousMode = process.env.NODE_ENV;
        const previousOrigin = process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
        const request = (headers: Record<string, string>) => new NextRequest("http://0.0.0.0:3000/api/admin/auth", { method: "POST", headers });
        try {
            Object.assign(process.env, { NODE_ENV: "development" });
            delete process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
            for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
                assert.equal(checkOrigin(request({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin" })), null, host);
            }
            const rejected = [
                { host: "localhost:3000", origin: "http://localhost:3001" },
                { host: "localhost:3000", origin: "http://127.0.0.1:3000" },
                { host: "localhost:3000", origin: "https://localhost:3000" },
                { host: "localhost:3000", origin: "https://evil.example" },
                { host: "localhost:3000", origin: "null" },
                { host: "localhost:3000" },
                { origin: "http://localhost:3000" },
                { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
                { host: "evil.example", origin: "http://evil.example" },
                { host: "localhost.evil.example", origin: "http://localhost.evil.example" },
                { host: "localhost:3000@evil.example", origin: "http://evil.example" },
                { host: "localhost:99999", origin: "http://localhost:3000" },
                { host: "0.0.0.0:3000", origin: "http://0.0.0.0:3000" },
                { host: "localhost:3000", origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
                { host: "evil.example", origin: "http://localhost:3000", "x-forwarded-host": "localhost:3000" },
            ];
            for (const headers of rejected) assert.equal(checkOrigin(request(headers as Record<string, string>))?.status, 403, JSON.stringify(headers));
            assert.equal(checkOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-host": "evil.example" })), null);

            process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "https://studio.example.com";
            assert.equal(checkOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000" }))?.status, 403);
            Object.assign(process.env, { NODE_ENV: "production" });
            assert.equal(checkOrigin(request({ host: "internal:3000", origin: "https://studio.example.com" })), null);
            for (const origin of ["https://evil.example", "http://studio.example.com", "https://studio.example.com:8443", "null"]) {
                assert.equal(checkOrigin(request({ host: "internal:3000", origin }))?.status, 403);
            }
            delete process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
            assert.equal(checkOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000" }))?.status, 403);
        } finally {
            if (previousMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
            else Object.assign(process.env, { NODE_ENV: previousMode });
            if (previousOrigin === undefined) delete process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
            else process.env.OPEN_HIGGSFIELD_APP_ORIGIN = previousOrigin;
        }
    });
    await t.test("persistent rate limiter enforces limit under concurrency", async () => {
        const result = await Promise.all(Array.from({ length: 10 }, () => auth.takeRateLimit("test", 3, 60_000)));
        assert.equal(result.filter(Boolean).length, 3);
    });
    await t.test("duplicate generation IDs never submit twice", async () => {
        const { generationEndpoint } = await import("../src/lib/generation-request");
        const { NextResponse } = await import("next/server");
        const key = crypto.randomUUID(); let submitted = 0;
        const request = (body = "same-input") => new NextRequest("http://localhost:3000/api/generate", { method: "POST", headers: { origin: "http://localhost:3000", cookie: `${auth.COOKIE_NAME}=${session}`, "idempotency-key": key }, body });
        const handler = async () => { submitted++; return NextResponse.json({ task_id: "test-task" }); };
        assert.equal((await generationEndpoint(request(), handler)).status, 200);
        assert.equal((await generationEndpoint(request(), handler)).status, 200);
        assert.equal(submitted, 1);
        assert.equal((await generationEndpoint(request("different-input"), handler)).status, 409);
    });
    await t.test("private media addresses are rejected including IPv4-mapped IPv6", async () => {
        const { assertSafeRemoteUrl } = await import("../src/lib/safe-url");
        for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "http://10.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd"]) await assert.rejects(assertSafeRemoteUrl(url));
    });
    await t.test("password change preserves vault and revokes all old sessions", async () => {
        const before = await store.getStoredConnection(id);
        const result = await auth.changeAdminPassword("new-test-password-long-enough", password, "password");
        assert.equal(await auth.verifyAdminSession(session), false);
        assert.equal(await auth.verifyAdminSession(result.token), true);
        assert.deepEqual(await store.getStoredConnection(id), before);
        await assert.rejects(auth.changeAdminPassword(password, recovery, "recovery"), /ERR_ADMIN_AUTH_FAILED/);
        recovery = result.recoveryCode;
        session = result.token;
    });
    await t.test("recovery code single-use and logout revocation", async () => {
        const result = await auth.changeAdminPassword(password, recovery, "recovery");
        assert.equal(await auth.verifyAdminSession(session), false);
        await assert.rejects(auth.changeAdminPassword(password, recovery, "recovery"), /ERR_ADMIN_AUTH_FAILED/);
        await auth.logoutAdmin(result.token);
        assert.equal(await auth.verifyAdminSession(result.token), false);
    });
    await t.test("ciphertext tampering fails closed", async () => {
        const file = path.join(directory, "provider-connections.enc.json");
        const envelope = JSON.parse(await fs.readFile(file, "utf8"));
        envelope.tag = crypto.randomBytes(16).toString("base64");
        await fs.writeFile(file, JSON.stringify(envelope));
        await assert.rejects(store.listProviderConnections(), /ERR_CONNECTION_STORE_UNREADABLE/);
    });
    await t.test("missing master key is not silently replaced", async () => {
        const master = path.join(directory, ".higgsfield-security/master-key.json");
        await fs.rename(master, `${master}.backup`);
        try {
            await assert.rejects(store.listProviderConnections(), /ERR_VAULT_KEY_MISSING/);
            await assert.rejects(fs.stat(master), { code: "ENOENT" });
        } finally { await fs.rename(`${master}.backup`, master); }
    });
    await t.test("legacy encrypted connections migrate without losing credentials", async () => {
        const legacySecret = crypto.randomBytes(32).toString("hex");
        const legacyKey = crypto.scryptSync(legacySecret, "open-higgsfield-provider-connections-v1", 32);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
        const apiKey = `legacy-test-${crypto.randomUUID()}`;
        const legacyId = crypto.randomUUID();
        const plaintext = JSON.stringify({ connections: [{ id: legacyId, provider: "openrouter", name: "legacy", config: {}, credentials: { apiKey }, enabled: true, isDefault: true, createdAt: "", updatedAt: "" }] });
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const file = path.join(directory, "provider-connections.enc.json");
        await fs.writeFile(file, JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
        process.env.OPEN_HIGGSFIELD_CREDENTIALS_KEY = legacySecret;
        assert.equal((await store.getStoredConnection(legacyId))?.credentials.apiKey, apiKey);
        await store.upsertProviderConnection({ id: legacyId, provider: "openrouter", name: "migrated", credentials: {} });
        delete process.env.OPEN_HIGGSFIELD_CREDENTIALS_KEY;
        assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 2);
        assert.equal((await store.getStoredConnection(legacyId))?.credentials.apiKey, apiKey);
    });
});
