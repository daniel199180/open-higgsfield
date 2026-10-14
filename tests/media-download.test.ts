import assert from "node:assert/strict";
import test from "node:test";
import { detectGeneratedMediaType, readGeneratedMediaResponse } from "../src/lib/media-download";

function ftyp(brand: string) {
    const data = Buffer.alloc(32);
    data.writeUInt32BE(24, 0);
    data.write("ftyp", 4);
    data.write(brand, 8);
    data.write("isom", 16);
    data.write("mdat", 24);
    return data;
}

test("generated video is recognized from bytes despite misleading CDN headers", () => {
    assert.equal(detectGeneratedMediaType(ftyp("isom")), "video/mp4");
    assert.equal(detectGeneratedMediaType(ftyp("qt  ")), "video/quicktime");
    assert.equal(detectGeneratedMediaType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]), Buffer.from("webm"), Buffer.alloc(24)])), "video/webm");
});

test("HTML error pages and truncated containers are never saved as video", () => {
    assert.equal(detectGeneratedMediaType(Buffer.from("<html><body>Access denied</body></html>")), undefined);
    assert.equal(detectGeneratedMediaType(Buffer.from("not a video at all")), undefined);
    assert.equal(detectGeneratedMediaType(Buffer.from("\0\0\0\xffftypisomxxxx")), undefined);
    assert.equal(detectGeneratedMediaType(ftyp("avif")), "image/avif");
});

test("official content response accepts MP4 bytes with a wrong MIME header", async () => {
    const media = await readGeneratedMediaResponse(new Response(ftyp("isom"), { headers: { "Content-Type": "application/octet-stream" } }));
    assert.equal(media.mimeType, "video/mp4");
    assert.equal(media.data.length, 32);
    await assert.rejects(readGeneratedMediaResponse(new Response("<html>expired</html>", { headers: { "Content-Type": "video/mp4" } })), /ERR_INVALID_GENERATED_MEDIA/);
});
