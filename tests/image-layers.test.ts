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
