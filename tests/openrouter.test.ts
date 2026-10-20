import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRouterFailure } from "../src/providers/openrouter-errors";
import { publicErrorMessage } from "../src/lib/public-error";
import type { ProviderGenerationRequest } from "../src/providers/types";
import sharp from "sharp";

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
    await t.test("reuses a private image as a reference for a second format without Cloudinary", async (t) => {
        const { imageReferenceForProvider } = await import("../src/lib/image-reference");
        const source = Buffer.from("test-reference-image");
        const reference = await imageReferenceForProvider("openrouter", source);
        assert.equal(reference, `data:image/jpeg;base64,${source.toString("base64")}`);
        const mock = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
            assert.equal(url.href, "https://openrouter.ai/api/v1/images");
            const payload = JSON.parse(options.body as string);
            assert.equal(payload.aspect_ratio, "9:16");
            assert.deepEqual(payload.input_references, [{ type: "image_url", image_url: { url: reference } }]);
            return Response.json({ data: [{ b64_json: Buffer.from("second-format").toString("base64") }] });
        });
        const result = await provider.submit({
            ...request,
            params: { ...request.params, aspect_ratio: "9:16" },
            media: { images: { input_references: reference } },
        });
        assert.equal(result.status, "COMPLETED");
        assert.equal(mock.mock.callCount(), 1);
    });
    await t.test("image editing sends the original, painted guide and optional reference to OpenRouter", async (t) => {
        const images = {
            source: "data:image/png;base64,c291cmNl",
            region_guide: "data:image/png;base64,Z3VpZGU=",
            reference: "data:image/png;base64,cmVmZXJlbmNl",
        };
        const mock = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
            assert.equal(url.href, "https://openrouter.ai/api/v1/images");
            const payload = JSON.parse(options.body as string);
            assert.equal(payload.model, "openai/gpt-image-2.5-sunburst");
            assert.equal(payload.aspect_ratio, "2:3");
            assert.equal(payload.quality, "high");
            assert.equal(payload.n, 1);
            assert.equal(payload.mask, undefined);
            assert.deepEqual(payload.input_references.map((item: { image_url: { url: string } }) => item.image_url.url), Object.values(images));
            return Response.json({ data: [{ b64_json: Buffer.from("edited-image").toString("base64"), media_type: "image/png" }] });
        });
        const result = await provider.submit({ ...request, providerModelId: "openai/gpt-image-2.5-sunburst", params: { ...request.params, aspect_ratio: "2:3", field_values: { quality: "high", n: 1 } }, media: { images } });
        assert.equal(result.status, "COMPLETED");
        assert.equal(mock.mock.callCount(), 1);
    });
    await t.test("sends multiple image, video and audio references for Seedance", async (t) => {
        const mock = t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
            const payload = JSON.parse(options.body as string);
            assert.deepEqual(payload.input_references, [
                { type: "image_url", image_url: { url: "https://cdn.example/style.png" } },
                { type: "image_url", image_url: { url: "https://cdn.example/character.png" } },
                { type: "video_url", video_url: { url: "https://cdn.example/motion.mp4" } },
                { type: "audio_url", audio_url: { url: "https://cdn.example/voice.wav" } },
            ]);
            return Response.json({ id: "video-job", status: "pending", polling_url: "/api/v1/videos/video-job" }, { status: 202 });
        });
        const result = await provider.submit({
            ...request,
            mediaType: "video",
            providerModelId: "bytedance/seedance-2.5",
            params: { ...request.params, duration: "5", field_values: {} },
            media: {
                reference_images: ["https://cdn.example/style.png", "https://cdn.example/character.png"],
                reference_videos: ["https://cdn.example/motion.mp4"],
                reference_audios: ["https://cdn.example/voice.wav"],
            },
        });
        assert.equal(result.status, "CREATED");
        assert.equal(mock.mock.callCount(), 1);
    });
    await t.test("requests PNG transparency and rejects a visually opaque result", async (t) => {
        const transparent = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
        const opaque = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
        const mock = t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
            const payload = JSON.parse(options.body as string);
            assert.equal(payload.background, "transparent");
            assert.equal(payload.output_format, "png");
            assert.equal(payload.input_references[0].image_url.url, "data:image/png;base64,cG5n");
            return Response.json({ data: [{ b64_json: transparent.toString("base64"), media_type: "image/png" }] });
        });
        const editRequest = { ...request, media: { images: { input_references: "data:image/png;base64,cG5n" } }, params: { ...request.params, field_values: { background: "transparent", output_format: "png" } } };
        const result = await provider.submit(editRequest);
        assert.equal(result.status, "COMPLETED");
        mock.mock.mockImplementation(async () => Response.json({ data: [{ b64_json: opaque.toString("base64"), media_type: "image/png" }] }));
        await assert.rejects(provider.submit(editRequest), /ERR_OPENROUTER_IMAGE_NOT_TRANSPARENT/);
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
    await t.test("recovers completed video from job content without submitting again", async (t) => {
        const mp4 = Buffer.alloc(32);
        mp4.writeUInt32BE(24, 0);
        mp4.write("ftypisom", 4);
        mp4.write("mdat", 24);
        const mock = t.mock.method(globalThis, "fetch", async (url: URL) => {
            if (url.pathname.endsWith("/content")) return new Response(mp4, { headers: { "Content-Type": "application/octet-stream" } });
            assert.equal(url.pathname, "/api/v1/videos/existing-job");
            return Response.json({ id: "existing-job", status: "completed", unsigned_urls: ["https://expired.example/video.mp4"], usage: { cost: 0.12 } });
        });
        const result = await provider.poll({ mediaType: "video", providerModelId: "alibaba/wan-3.0", operation: { connectionId: connection.id, jobId: "existing-job" } });
        assert.equal(result.status, "COMPLETED");
        if (result.status === "COMPLETED") {
            assert.deepEqual(Buffer.from(result.assets[0].data!), mp4);
            assert.equal(result.assets[0].mimeType, "video/mp4");
        }
        assert.equal(mock.mock.callCount(), 2);
    });
});
