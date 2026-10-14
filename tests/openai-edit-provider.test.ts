import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ProviderGenerationRequest } from "../src/providers/types";

test("OpenAI edit adapter sends a private masked multipart request and reports usage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-edit-test-"));
    const oldDirectory = process.env.OPEN_HIGGSFIELD_STORAGE_DIR;
    const oldKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    process.env.OPENAI_API_KEY = "sk-test-private";
    try {
        const { OpenAIProvider } = await import("../src/providers/openai");
        const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffffff" } }).png().toBuffer();
        const uri = `data:image/png;base64,${png.toString("base64")}`;
        const request = {
            mediaType: "image", modelId: "openai:edit:gpt-image-2.5-sunburst", providerModelId: "gpt-image-2.5-sunburst",
            capabilities: { id: "openai:edit:gpt-image-2.5-sunburst", label: "GPT Image 2.5", provider: "openai", family: "OpenAI", variant: "edit", group: "Edit",
                prompt_required: true, duration: false, aspect_ratio: false, size: false, resolution_variant: false,
                negative_prompt: false, cfg_scale: false, style: false, shot_type: false, prompt_expansion: false, elements: false,
                media_slots: [], custom_fields: [] },
            params: { model_id: "openai:edit:gpt-image-2.5-sunburst", prompt: "Change only the sky", size: "1024x1024", field_values: { quality: "high" } },
            media: { images: { source: uri, mask: uri, reference: uri } },
        } satisfies ProviderGenerationRequest;
        let calls = 0;
        globalThis.fetch = async (input, init) => {
            calls++;
            assert.equal(String(input), "https://api.openai.com/v1/images/edits");
            assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-test-private");
            const form = init?.body as FormData;
            assert.equal(form.get("model"), "gpt-image-2.5-sunburst");
            assert.equal(form.get("prompt"), "Change only the sky");
            assert.equal(form.getAll("image[]").length, 2);
            assert.ok(form.get("mask") instanceof File);
            return Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 4, output_tokens: 12, total_tokens: 16 } });
        };
        const provider = new OpenAIProvider();
        const result = await provider.submit(request);
        assert.equal(result.status, "COMPLETED");
        assert.equal(result.usage?.totalTokens, 16);
        assert.equal(calls, 1);
        await assert.rejects(() => provider.submit({ ...request, providerModelId: "not-an-image-model" }), /MODEL_UNSUPPORTED/);
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
        if (oldDirectory === undefined) delete process.env.OPEN_HIGGSFIELD_STORAGE_DIR; else process.env.OPEN_HIGGSFIELD_STORAGE_DIR = oldDirectory;
        if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
