import assert from "node:assert/strict";
import test from "node:test";
import { imageReferenceForProvider } from "../src/lib/image-reference";
import { fetchMedia } from "../src/providers/utils";

test("Google image references stay private and are decoded locally", async (t) => {
    const source = Buffer.from("test-image-bytes");
    const remoteFetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected remote upload"); });
    const reference = await imageReferenceForProvider("google-ai-studio", source);
    assert.equal(reference, `data:image/jpeg;base64,${source.toString("base64")}`);
    const media = await fetchMedia(reference);
    assert.equal(media.mimeType, "image/jpeg");
    assert.deepEqual(Buffer.from(media.data), source);
    assert.equal(remoteFetch.mock.callCount(), 0);
    await assert.rejects(fetchMedia("data:text/html;base64,SGVsbG8="), /ERR_INVALID_MEDIA_TYPE/);
});
