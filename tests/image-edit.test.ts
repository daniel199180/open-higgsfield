import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DEFAULT_OPENROUTER_EDIT_MODEL, isOpenRouterEditModel, OPENROUTER_EDIT_MODELS, availableOpenRouterEditModels, supportsOpenRouterEditOptions, supportedOpenRouterEditRatios } from "../src/lib/openrouter-edit-models";
import { calculateOutpaintLayout, planOutpaint } from "../src/lib/image-outpaint";
import { finishOutpaint, lockOutpaintOriginal, makeOutpaintGuide } from "../src/lib/image-outpaint-server";
import { editGuideForOpenRouter, ImageEditInputError, maskForImageEdit, normalizeImageEditInput, parseImageEditComments, regionGuideForOpenRouter } from "../src/lib/image-edit-source";

test("image editor offers only compatible OpenRouter GPT Image models", () => {
    assert.equal(DEFAULT_OPENROUTER_EDIT_MODEL, "openai/gpt-image-2.5-sunburst");
    assert.deepEqual(OPENROUTER_EDIT_MODELS.map((model) => model.id), ["openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare"]);
    assert.equal(isOpenRouterEditModel("openai/gpt-image-2.5-flare"), true);
    assert.equal(isOpenRouterEditModel("gpt-image-2.5-flare"), false);
    const compatible = { id: "openai/gpt-image-2.5-sunburst", architecture: { input_modalities: ["image", "text"], output_modalities: ["image"] }, supported_parameters: { input_references: { max: 2 }, quality: { values: ["high", "medium"] }, aspect_ratio: { values: ["auto", "1:1"] } } };
    assert.deepEqual(availableOpenRouterEditModels([compatible]).map((model) => model.id), [compatible.id]);
    assert.equal(supportsOpenRouterEditOptions(compatible, "high", "1:1", 2), true);
    assert.equal(supportsOpenRouterEditOptions(compatible, "high", "1:1", 3), false);
    assert.equal(supportsOpenRouterEditOptions(compatible, "low", "1:1", 1), false);
    assert.deepEqual(supportedOpenRouterEditRatios(compatible), ["auto", "1:1"]);
    assert.deepEqual(availableOpenRouterEditModels([{ ...compatible, architecture: { input_modalities: ["text"], output_modalities: ["image"] } }]), []);
});

test("outpainting expands without cropping and positions the original on every side", () => {
    const center = calculateOutpaintLayout(120, 80, "1:1", 20, "center");
    assert.deepEqual([center.width, center.height], [144, 144]);
    assert.deepEqual([center.left, center.top], [12, 32]);
    const left = calculateOutpaintLayout(120, 80, "9:16", 20, "left");
    assert.equal(left.left, 0);
    assert.ok(left.width > 120 && left.height > 80);
    const bottom = calculateOutpaintLayout(120, 80, "16:9", 20, "bottom");
    assert.equal(bottom.top, bottom.height - 80);
    assert.throws(() => calculateOutpaintLayout(120, 80, "1:1", 0, "center"));
});

test("outpainting guide leaves new border transparent and pixel-lock retains the source", async () => {
    const original = await sharp({ create: { width: 12, height: 8, channels: 4, background: "#0000ffff" } }).png().toBuffer();
    const layout = calculateOutpaintLayout(12, 8, "1:1", 20, "center");
    const guide = await makeOutpaintGuide(original, layout);
    const guidePixels = await sharp(guide).ensureAlpha().raw().toBuffer();
    assert.equal(guidePixels[3], 0, "outer border is transparent");
    const insideGuide = (layout.top * layout.width + layout.left) * 4;
    assert.equal(guidePixels[insideGuide + 2], 255, "source is visible in the guide");
    const generated = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#ff0000ff" } }).png().toBuffer();
    const locked = await lockOutpaintOriginal(generated, original, layout);
    const pixels = await sharp(locked).ensureAlpha().raw().toBuffer();
    assert.deepEqual([pixels[0], pixels[1], pixels[2]], [255, 0, 0], "generated border remains");
    const inside = (layout.top * layout.width + layout.left) * 4;
    assert.deepEqual([pixels[inside], pixels[inside + 1], pixels[inside + 2]], [0, 0, 255], "original pixel is unchanged");
});

test("freely dragged borders keep exact asymmetric output and original pixels", async () => {
    const padding = { left: 2, right: 5, top: 1, bottom: 3 };
    const plan = planOutpaint(12, 8, padding, ["1:1", "3:2"]);
    assert.deepEqual(plan.target, { width: 19, height: 12, left: 2, top: 1, sourceWidth: 12, sourceHeight: 8 });
    assert.ok(plan.provider.width >= plan.target.width && plan.provider.height >= plan.target.height);
    assert.ok(["1:1", "3:2"].includes(plan.ratio));
    const original = await sharp({ create: { width: 12, height: 8, channels: 4, background: "#0000ffff" } }).png().toBuffer();
    const generated = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#ff0000ff" } }).png().toBuffer();
    const guide = await makeOutpaintGuide(original, plan.provider);
    const guidePixels = await sharp(guide).ensureAlpha().raw().toBuffer();
    assert.equal(guidePixels[3], 0);
    const finished = await finishOutpaint(generated, original, plan, true);
    const { data, info } = await sharp(finished).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [19, 12]);
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)];
    assert.deepEqual(pixel(0, 0), [255, 0, 0]);
    assert.deepEqual(pixel(2, 1), [0, 0, 255]);
    assert.deepEqual(pixel(13, 8), [0, 0, 255]);
    assert.deepEqual(pixel(18, 11), [255, 0, 0]);
    const unlocked = await finishOutpaint(generated, original, plan, false);
    const unlockedPixels = await sharp(unlocked).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...unlockedPixels.subarray((1 * 19 + 2) * 4, (1 * 19 + 2) * 4 + 3)], [255, 0, 0]);
    assert.throws(() => planOutpaint(12, 8, { left: 0, right: 0, top: 0, bottom: 0 }, ["1:1"]));
    assert.throws(() => planOutpaint(12, 8, { left: 0, right: 13, top: 0, bottom: 0 }, ["1:1"]));
    assert.throws(() => planOutpaint(12, 8, padding, []));
});

test("image editor normalizes raster inputs and rejects non-image content", async () => {
    const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    const converted = await normalizeImageEditInput(jpeg);
    assert.deepEqual([converted.width, converted.height], [48, 32]);
    assert.equal((await sharp(converted.png).metadata()).format, "png");
    await assert.rejects(() => normalizeImageEditInput(Buffer.from("<script>alert(1)</script>")), ImageEditInputError);
});

test("mask must be an equally sized PNG with both protected and editable pixels", async () => {
    const opaque = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffffff" } }).png().toBuffer();
    await assert.rejects(() => maskForImageEdit(opaque, 16, 16), ImageEditInputError);
    const pixels = Buffer.alloc(16 * 16 * 4, 255);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels[(y * 16 + x) * 4 + 3] = 0;
    const mask = await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
    assert.deepEqual(await maskForImageEdit(mask, 16, 16), mask);
    await assert.rejects(() => maskForImageEdit(mask, 32, 32), ImageEditInputError);
    const original = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#0000ffff" } }).png().toBuffer();
    const guide = await regionGuideForOpenRouter(original, mask, 16, 16);
    const { data } = await sharp(guide).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > data[2], "the editable region is visibly marked in red");
    const unmarked = (12 * 16 + 12) * 4;
    assert.equal(data[unmarked], 0);
    assert.equal(data[unmarked + 2], 255);
});

test("numbered comments validate positions and create a visual guide without altering the original", async () => {
    const comments = parseImageEditComments(JSON.stringify([{ x: 0.5, y: 0.5, text: "Cambia el color de esta zona" }, { x: 0.75, y: 0.25, text: "Quita el texto" }]));
    assert.equal(comments.length, 2);
    assert.throws(() => parseImageEditComments(JSON.stringify([{ x: 1.1, y: 0.2, text: "Mal" }])), ImageEditInputError);
    assert.throws(() => parseImageEditComments(JSON.stringify([{ x: 0.2, y: 0.2, text: " " }])), ImageEditInputError);
    assert.throws(() => parseImageEditComments(JSON.stringify(Array.from({ length: 9 }, () => comments[0]))), ImageEditInputError);
    const original = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#0000ffff" } }).png().toBuffer();
    const guide = await editGuideForOpenRouter(original, null, comments, 128, 128);
    const metadata = await sharp(guide).metadata();
    assert.deepEqual([metadata.width, metadata.height], [128, 128]);
    assert.notDeepEqual(guide, original);
    const originalPixel = await sharp(original).raw().toBuffer();
    const guidePixel = await sharp(guide).raw().toBuffer();
    assert.deepEqual([...guidePixel.subarray(0, 4)], [...originalPixel.subarray(0, 4)], "unmarked corners remain unchanged");
});
