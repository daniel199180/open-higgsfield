import { test } from "node:test";
import assert from "node:assert/strict";
import { audioMime } from "../src/workflows/assets";
import { templateGraph } from "../src/workflows/templates";
import { validateGraph, validateRunnable } from "../src/workflows/validation";
import { outputKind } from "../src/workflows/types";
import { providerUrl } from "../src/providers/secure-fetch";
import { openRouterSpeechModels } from "../src/audio/provider";

test("audio sniffing accepts MP3/WAV and rejects an HTML payload", () => {
    assert.equal(audioMime(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)])), "audio/mpeg");
    assert.equal(audioMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)])), "audio/wav");
    assert.throws(() => audioMime(Buffer.from("<html>Access denied from provider</html>")), /MP3 o WAV/);
});

test("audio workflow requires a voice, model and text, and connects to audio outputs", () => {
    const graph = templateGraph("audio");
    assert.deepEqual(validateGraph(graph), graph);
    assert.equal(outputKind(graph.nodes[1]), "audio");
    assert.throws(() => validateRunnable(graph, {}), /Elige voz, modelo y texto/);
    graph.nodes[1].config.voiceId = "97e16ccc-28fd-4669-956f-58ea50da7ae8";
    graph.nodes[1].config.modelId = "eleven_multilingual_v2";
    validateRunnable(graph, {});
    const mismatch = structuredClone(graph);
    mismatch.nodes[2].config.valueKind = "image";
    assert.throws(() => validateGraph(mismatch), /compatibles/);
});

test("ElevenLabs requests stay on its fixed official origin", () => {
    assert.equal(providerUrl("elevenlabs", "/v1/voices/add").origin, "https://api.elevenlabs.io");
    assert.throws(() => providerUrl("elevenlabs", "https://example.com/v1/voices/add"), /NOT_ALLOWED/);
});

test("OpenRouter speech catalog exposes only models with selectable voices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
        assert.equal(String(input), "https://openrouter.ai/api/v1/models?output_modalities=speech");
        return Response.json({ data: [
            { id: "elevenlabs/eleven-v4-turbo", name: "Eleven v4 Turbo", supported_voices: ["sarah", "daniel"] },
            { id: "bytedance-seed/seed-audio-1-0", name: "Seed Audio", supported_voices: [] },
        ] });
    };
    try {
        const models = await openRouterSpeechModels({
            id: "test", provider: "openrouter", name: "OpenRouter", enabled: true, isDefault: true,
            config: {}, credentials: { apiKey: "test" }, createdAt: "", updatedAt: "",
        });
        assert.deepEqual(models, [{ id: "elevenlabs/eleven-v4-turbo", name: "Eleven v4 Turbo", voices: ["sarah", "daniel"] }]);
    } finally { globalThis.fetch = originalFetch; }
});
