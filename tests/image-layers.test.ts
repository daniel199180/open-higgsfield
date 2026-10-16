import test from "node:test";
import assert from "node:assert/strict";

test("parses APIMart layer URLs and bounding boxes into an editable layer set", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition({
        result: {
            url: ["https://media.example/base.png", "https://media.example/subject.png"],
            layers: [
                { z_index: 0, name: "Base", bounding_box: { absolute: [0, 0, 1200, 800], normalized: [0, 0, 1000, 1000] }, size: { width: 1200, height: 800 } },
                { z_index: 1, name: "Sujeto", description: "Personaje aislado", bounding_box: { absolute: { x1: 120, y1: 40, x2: 720, y2: 760 }, normalized: [100, 50, 600, 950] }, size: [600, 720] },
            ],
        },
    }, 1200, 800);
    assert.ok(parsed);
    assert.equal(parsed.urls.length, 2);
    assert.equal(parsed.layers[1]?.name, "Sujeto");
    assert.deepEqual(parsed.layers[1]?.boundingBox.absolute, [120, 40, 720, 760]);
    assert.deepEqual(parsed.layers[1]?.size, { width: 600, height: 720 });
});

test("accepts completed APIMart responses nested under data", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition({ data: { status: "completed", images: ["https://media.example/base.png"] } }, 640, 480);
    assert.ok(parsed);
    assert.equal(parsed.layers[0]?.boundingBox.absolute[2], 640);
    assert.equal(parsed.layers[0]?.boundingBox.absolute[3], 480);
});

test("preserves Seedream data order and provider canvas coordinates", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition({
        data: [
            { url: "https://media.example/base.png", z_index: 0, size: "2048x1365", name: "Base" },
            { url: "https://media.example/front.png", z_index: 2, name: "Frente", bounding_box: { absolute: [400, 120, 1200, 900], normalized: [195, 88, 586, 659] } },
            { url: "https://media.example/back.png", z_index: 1, name: "Fondo", bounding_box: { absolute: [20, 30, 900, 1000], normalized: [10, 22, 439, 733] } },
        ],
    }, 1200, 800);
    assert.ok(parsed);
    assert.deepEqual(parsed.canvasSize, { width: 2048, height: 1365 });
    assert.deepEqual(parsed.urls, ["https://media.example/base.png", "https://media.example/front.png", "https://media.example/back.png"]);
    assert.equal(parsed.layers[1]?.zIndex, 2);
    assert.deepEqual(parsed.layers[2]?.boundingBox.absolute, [20, 30, 900, 1000]);
});

test("derives canonical pixel bounds from normalized metadata and identifies a non-first base", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition({
        result: {
            data: [
                { url: "https://media.example/subject.png", name: "Producto", z_index: 3, bounding_box: { normalized: [250, 125, 750, 875] } },
                { url: "https://media.example/background.png", name: "Background", role: "base", z_index: 0, size: "1600x900" },
            ],
        },
    }, 800, 450);
    assert.ok(parsed);
    assert.equal(parsed.baseProviderIndex, 1);
    assert.equal(parsed.layers[0]?.role, "layer");
    assert.equal(parsed.layers[1]?.role, "base");
    assert.deepEqual(parsed.layers[0]?.boundingBox.absolute, [400, 112.5, 1200, 787.5]);
    assert.equal(parsed.layers[0]?.boundingBoxSource, "normalized");
    assert.deepEqual(parsed.layers[1]?.boundingBox.absolute, [0, 0, 1600, 900]);
});

test("rejects a decomposition packet without layer positions or stacking metadata", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    assert.throws(() => parseLayerDecomposition({
        result: {
            url: ["https://media.example/base.png", "https://media.example/icon.png"],
            layers: [
                { name: "Base", size: "1000x1000" },
                { name: "Icon" },
            ],
        },
    }, 1000, 1000), /orden de apilamiento/);
});

// Exact nesting and parallel-array contract published by APIMart, including
// the one-pixel difference between crop size and right-minus-left in its sample.
function documentedResponse() {
    return { data: { status: "completed", result: { images: [{
        url: ["https://media.example/base.jpeg", "https://media.example/title.png", "https://media.example/tagline.png"],
        sizes: ["2048x2048", "1273x265", "492x98"],
        output_formats: ["jpeg", "png", "png"], layer_decomposition: true,
        layers: [
            { z_index: 0, size: "2048x2048", output_format: "jpeg" },
            { z_index: 2, size: "1273x265", output_format: "png", name: "Title text", bounding_box: { absolute: [383, 120, 1655, 384], normalized: [187, 59, 808, 188] } },
            { z_index: 1, size: "492x98", output_format: "png", name: "Upper-left tagline", bounding_box: { absolute: [140, 451, 631, 548], normalized: [68, 220, 308, 268] } },
        ],
    }] } } };
}

test("reads the documented task response without losing positions inside result.images[0]", async () => {
    const { parseLayerDecomposition, validateLayerPositions } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition(documentedResponse(), 941, 1672)!;
    assert.deepEqual(parsed.canvasSize, { width: 2048, height: 2048 });
    assert.equal(parsed.baseProviderIndex, 0);
    assert.equal(parsed.layers[0].role, "base");
    assert.equal(parsed.layers[1].name, "Title text");
    assert.equal(parsed.layers[1].zIndex, 2);
    assert.equal(parsed.layers[2].zIndex, 1);
    assert.deepEqual(parsed.layers[1].boundingBox.absolute, [383, 120, 1655, 384]);
    assert.deepEqual(parsed.layers[2].size, { width: 492, height: 98 });
    validateLayerPositions(parsed.layers, 2048, 2048);
});

test("rejects unequal parallel arrays and never shifts metadata onto another URL", async () => {
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const input = documentedResponse();
    input.data.result.images[0].url.splice(1, 1);
    assert.throws(() => parseLayerDecomposition(input, 2048, 2048), /posiciones completas/);
});

test("normalized APIMart coordinates always use 0–1000, including tiny boxes", async () => {
    const { parseLayerDecomposition, validateLayerPositions } = await import("../src/lib/image-layers");
    const input = documentedResponse();
    input.data.result.images[0].layers[1].bounding_box = { absolute: [], normalized: [0, 0, 1, 1] };
    const parsed = parseLayerDecomposition(input, 2048, 2048)!;
    assert.deepEqual(parsed.layers[1].boundingBox.absolute, [0, 0, 2.048, 2.048]);
    validateLayerPositions(parsed.layers, 2048, 2048);
});

test("refuses old fallback coordinates instead of presenting a pile of layers at 0,0", async () => {
    const { parseLayerDecomposition, validateLayerPositions } = await import("../src/lib/image-layers");
    const { hasReliableLayerLayout } = await import("../src/lib/image-layer-layout");
    const parsed = parseLayerDecomposition(documentedResponse(), 2048, 2048)!;
    parsed.layers[1].boundingBoxSource = "fallback";
    assert.throws(() => validateLayerPositions(parsed.layers, 2048, 2048), /Faltan posiciones/);
    assert.equal(hasReliableLayerLayout({ version: 3, model: "seedream", sourceWidth: 2048, sourceHeight: 2048, baseIndex: 0, layers: parsed.layers }), false);
});

test("preserves cropped PNG pixels and refuses to stretch incorrectly sized outputs", async () => {
    const sharp = (await import("sharp")).default;
    const { parseLayerDecomposition, fitLayerToBounds } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition(documentedResponse(), 2048, 2048)!;
    const crop = await sharp({ create: { width: 1273, height: 265, channels: 4, background: "#ff5500" } }).png().toBuffer();
    const fitted = await fitLayerToBounds(crop, { ...parsed.layers[1], index: 2 }, 2048, 2048);
    assert.equal((await sharp(fitted.buffer).metadata()).width, 1273);
    assert.deepEqual(fitted.boundingBox.absolute, [383, 120, 1655, 384]);
    const wrongCrop = await sharp(crop).resize(500, 800).png().toBuffer();
    await assert.rejects(fitLayerToBounds(wrongCrop, { ...parsed.layers[1], index: 2 }, 2048, 2048), /tamaño de una capa/);
    await assert.rejects(fitLayerToBounds(crop, { ...parsed.layers[1], index: 2, boundingBoxSource: "fallback" }, 2048, 2048), /posición original/);
});

test("selection and export geometry use the same canvas scale, including narrow layers", async () => {
    const { layerFrame } = await import("../src/lib/image-layer-layout");
    const { parseLayerDecomposition } = await import("../src/lib/image-layers");
    const parsed = parseLayerDecomposition(documentedResponse(), 2048, 2048)!;
    const set = { version: 4 as const, model: "seedream", sourceWidth: 2048, sourceHeight: 2048, baseIndex: 0, layers: parsed.layers };
    assert.deepEqual(layerFrame(parsed.layers[1], set), { left: 383, top: 120, width: 1272, height: 264 });
    assert.deepEqual(layerFrame(parsed.layers[1], set, { x: 10, y: -5, scale: 1.5 }), { left: 269.79999999999995, top: -48.400000000000006, width: 1908, height: 396 });
});
