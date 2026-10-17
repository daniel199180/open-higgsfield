import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderGenerationRequest } from "../src/providers/types";

test("APIMart uses its fixed official API, Bearer credentials, and asynchronous task results", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgsfield-apimart-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const { upsertProviderConnection } = await import("../src/lib/connection-store");
    const { ApiMartProvider } = await import("../src/providers/apimart");
    const connection = await upsertProviderConnection({ provider: "apimart", name: "APIMart", credentials: { apiKey: "apimart-test-key" } });
    const provider = new ApiMartProvider();
    const image = {
        mediaType: "image", modelId: "image", providerModelId: "gpt-image-2.5-sunburst", connectionId: connection.id, capabilities: {} as ProviderGenerationRequest["capabilities"],
        params: { model_id: "image", prompt: "A ceramic mug", aspect_ratio: "1:1", resolution: "2k", field_values: { quality: "high" } }, media: { images: { input_references: "https://cdn.example/source.png" } },
    } as ProviderGenerationRequest;

    await t.test("submits images to the OpenAI-compatible endpoint", async (t) => {
        const mock = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
            assert.equal(url.href, "https://api.apimart.ai/v1/images/generations");
            assert.equal((options.headers as Record<string, string>).Authorization, "Bearer apimart-test-key");
            assert.deepEqual(JSON.parse(options.body as string), { model: "gpt-image-2.5-sunburst", prompt: "A ceramic mug", size: "1:1", resolution: "2k", quality: "high", n: 1, image_urls: ["https://cdn.example/source.png"] });
            return Response.json({ code: 200, data: [{ status: "submitted", task_id: "task-image" }] });
        });
        const result = await provider.submit(image);
        assert.equal(result.status, "CREATED");
        assert.equal(result.providerTaskId, "task-image");
        assert.equal(mock.mock.callCount(), 1);
    });

    await t.test("submits videos and resolves a completed task without retrying", async (t) => {
        const video = { ...image, mediaType: "video" as const, providerModelId: "doubao-seedance-2.0", params: { ...image.params, duration: "5", field_values: { generate_audio: true } }, media: { images: { start_image: "https://cdn.example/first.png", end_image: "https://cdn.example/last.png" } } };
        const mock = t.mock.method(globalThis, "fetch", async (url: URL, options?: RequestInit) => {
            if (url.pathname === "/v1/videos/generations") {
                assert.deepEqual(JSON.parse(options?.body as string), { model: "doubao-seedance-2.0", prompt: "A ceramic mug", duration: 5, resolution: "2k", size: "1:1", generate_audio: true, image_urls: ["https://cdn.example/first.png", "https://cdn.example/last.png"] });
                return Response.json({ code: 200, data: [{ status: "submitted", task_id: "task-video" }] });
            }
            assert.equal(url.href, "https://api.apimart.ai/v1/tasks/task-video?language=es");
            return Response.json({ id: "task-video", status: "completed", result: { videos: [{ url: "https://media.example/output.mp4" }] } });
        });
        const submitted = await provider.submit(video);
        assert.equal(submitted.status, "CREATED");
        const result = await provider.poll({ mediaType: "video", providerModelId: "doubao-seedance-2.0", operation: { connectionId: connection.id, taskId: "task-video" } });
        assert.equal(result.status, "COMPLETED");
        if (result.status === "COMPLETED") assert.equal(result.assets[0]?.url, "https://media.example/output.mp4");
        assert.equal(mock.mock.callCount(), 2);
    });

    await t.test("never exposes APIMart request details on rejection", async (t) => {
        t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "apimart-test-key private request" } }, { status: 401 }));
        await assert.rejects(provider.submit(image), /ERR_APIMART_KEY_REJECTED/);
    });

    await t.test("classifies a prompt limit without exposing provider details", async (t) => {
        t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "prompt is too long: private content" } }, { status: 422 }));
        await assert.rejects(provider.submit(image), /ERR_APIMART_PROMPT_TOO_LONG/);
    });
});
