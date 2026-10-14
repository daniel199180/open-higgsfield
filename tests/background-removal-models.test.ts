import test from "node:test";
import assert from "node:assert/strict";
import { backgroundRemovalModels } from "../src/lib/background-removal-models";

test("background removal only offers GPT image models with input images and transparent PNG", () => {
    const eligible = (id: string) => ({
        id, name: id, architecture: { input_modalities: ["text", "image"] },
        supported_parameters: { background: { values: ["auto", "transparent", "opaque"] }, output_format: { values: ["png", "webp"] } },
    });
    const models = backgroundRemovalModels([
        eligible("openai/gpt-image-2.5-flare"),
        eligible("openai/gpt-image-2.5-sunburst"),
        { ...eligible("openai/gpt-image-2"), supported_parameters: { background: { values: ["opaque"] } } },
        { ...eligible("openai/gpt-image-1.5"), architecture: { input_modalities: ["text"] } },
        { ...eligible("openai/gpt-image-1"), supported_parameters: { background: { values: ["transparent"] }, output_format: { values: ["jpeg"] } } },
        eligible("sourceful/riverflow-v2.5"),
    ]);
    assert.deepEqual(models.map((model) => model.id), ["openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare"]);
    assert.deepEqual(backgroundRemovalModels(null), []);
});
