import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { previewVector, sanitizeVectorSvg, traceLogoImage } from "../src/social/vector";

test("SVG sanitizer discards active content and external references", () => {
    const safe = sanitizeVectorSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="https://example.com/x"/><path d="M0 0h100v100H0Z" fill="red" onclick="alert(2)"/></svg>`).toString();
    assert.match(safe, /<path/);
    assert.doesNotMatch(safe, /script|foreignObject|<image|onload|onclick|https:/i);
    assert.throws(() => sanitizeVectorSvg(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>`));
});

test("local vectorization creates editable paths and PNG preview", async () => {
    const input = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ffffff" } }).composite([{ input: Buffer.from(`<svg width="64" height="64"><circle cx="32" cy="32" r="20" fill="#203060"/></svg>`), left: 0, top: 0 }]).png().toBuffer();
    const svg = await traceLogoImage(input, 4);
    assert.match(svg.toString(), /<path/);
    const png = await previewVector(svg);
    assert.equal((await sharp(png).metadata()).format, "png");
});
