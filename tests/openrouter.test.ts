import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRouterFailure } from "../src/providers/openrouter-errors";
import { publicErrorMessage } from "../src/lib/public-error";
import type { ProviderGenerationRequest } from "../src/providers/types";

test("OpenRouter errors expose only closed codes, never upstream secrets", () => {
    const cases: [number, string][] = [
        [400, "PARAMETERS"], [401, "AUTH"], [402, "CREDITS"], [403, "FORBIDDEN"],
        [404, "MODEL_UNAVAILABLE"], [408, "TIMEOUT"], [422, "PARAMETERS"],
        [429, "RATE_LIMIT"], [500, "PROVIDER_UNAVAILABLE"], [502, "PROVIDER_UNAVAILABLE"], [504, "TIMEOUT"],
    ];
    for (const [status, suffix] of cases) {
        const diagnostic = openRouterFailure(status, { error: { code: status, message: "secret-api-key prompt private", metadata: { raw: "secret" } } });
        assert.equal(diagnostic.code, `ERR_OPENROUTER_${suffix}`);
        assert.equal(publicErrorMessage(new Error(diagnostic.code)), diagnostic.code);
        assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
    }
    assert.equal(openRouterFailure(200, { error: { code: 402 } }).code, "ERR_OPENROUTER_CREDITS");
    assert.equal(openRouterFailure(404, { error: { message: "No endpoints found matching your data policy" } }).code, "ERR_OPENROUTER_PRIVACY");
});

test("OpenRouter adapter: request contract, responses, safe failures and no retries", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgsfield-openrouter-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const { upsertProviderConnection } = await import("../src/lib/connection-store");
    const { OpenRouterProvider } = await import("../src/providers/openrouter");
    const connection = await upsertProviderConnection({ provider: "openrouter", name: "test", credentials: { apiKey: "dummy-test-key" } });
    const provider = new OpenRouterProvider();
    const request = {
        mediaType: "image", modelId: "test", providerModelId: "black-forest-labs/flux.2-pro",
        connectionId: connection.id, capabilities: {},
        params: { model_id: "test", prompt: "A ceramic mug", aspect_ratio: "1:1", field_values: {} }, media: {},
    } as ProviderGenerationRequest;
    await t.test("sends native images payload and decodes output", async (t) => {
        const mock = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
            assert.equal(url.href, "https://openrouter.ai/api/v1/images");
            assert.equal(options.redirect, "error");
            assert.deepEqual(JSON.parse(options.body as string), { model: request.providerModelId, prompt: "A ceramic mug", aspect_ratio: "1:1", n: 1 });
            return Response.json({ data: [{ b64_json: Buffer.from("test-image").toString("base64"), media_type: "image/webp" }], usage: { prompt_tokens: 15, completion_tokens: 1290, total_tokens: 1305, cost: 0.039 } });
        });
        const result = await provider.submit(request);
        assert.equal(result.status, "COMPLETED");
        assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 1290, totalTokens: 1305, costUsd: 0.039 });
        if (result.status === "COMPLETED") assert.equal(Buffer.from(result.assets[0].data!).toString(), "test-image");
        assert.equal(mock.mock.callCount(), 1);
    });
    for (const status of [400, 402, 429, 502]) await t.test(`HTTP ${status} gives a safe error without retries`, async (t) => {
        const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: status, message: "dummy-test-key secret prompt" } }, { status }));
        const logs: unknown[][] = [];
        t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
        await assert.rejects(provider.submit(request), new RegExp(openRouterFailure(status, {}).code));
        assert.equal(mock.mock.callCount(), 1);
        assert.equal(JSON.stringify(logs).includes("dummy-test-key"), false);
        assert.equal(JSON.stringify(logs).includes("secret prompt"), false);
    });
    await t.test("handles embedded errors, malformed success and network timeout", async (t) => {
        const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: 402 } }));
        t.mock.method(console, "warn", () => {});
        await assert.rejects(provider.submit(request), /ERR_OPENROUTER_CREDITS/);
        mock.mock.mockImplementation(async () => new Response("not JSON"));
        await assert.rejects(provider.submit(request), /ERR_OPENROUTER_INVALID_RESPONSE/);
        mock.mock.mockImplementation(async () => Response.json({ data: {} }));
        await assert.rejects(provider.submit(request), /ERR_OPENROUTER_INVALID_RESPONSE/);
        mock.mock.mockImplementation(async () => Response.json({ data: [] }));
        await assert.rejects(provider.submit(request), /ERR_NO_IMAGE_GENERATED/);
        mock.mock.mockImplementation(async () => { throw new DOMException("private upstream detail", "TimeoutError"); });
        await assert.rejects(provider.submit(request), /ERR_OPENROUTER_TIMEOUT/);
    });
});
