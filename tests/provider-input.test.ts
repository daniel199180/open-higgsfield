import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";

test("provider references are private by default and served only through expiring signed URLs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-provider-input-"));
    const originalStorage = process.env.OPEN_HIGGSFIELD_STORAGE_DIR;
    const originalOrigin = process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    delete process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
    try {
        const { publishProviderInput, readProviderInput } = await import("../src/lib/provider-input");
        const { imageReferenceForProvider, providerImageReference } = await import("../src/lib/image-reference");
        const { normalizeImageReference } = await import("../src/lib/media-upload");
        const source = Buffer.from("reference-image");
        const inline = await imageReferenceForProvider("apimart", source, "seedream-5-0-pro");
        assert.equal(inline, `data:image/jpeg;base64,${source.toString("base64")}`);
        const transparentLogo = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#00000000" } }).png().toBuffer();
        const normalized = await normalizeImageReference(transparentLogo);
        assert.equal(normalized.mimeType, "image/png");
        assert.equal((await sharp(normalized.data).metadata()).hasAlpha, true);
        await assert.rejects(imageReferenceForProvider("apimart", source, "unknown-image-model"), /ERR_PUBLIC_REFERENCE_ORIGIN_REQUIRED/);
        process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "https://localhost:3000";
        await assert.rejects(publishProviderInput(source, "image/jpeg"), /ERR_PUBLIC_REFERENCE_ORIGIN_REQUIRED/);

        process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "https://studio.example.com";
        const fallback = await providerImageReference("apimart", normalized.data, "image/png", "model-without-inline-contract");
        assert.match(fallback, /^https:\/\/studio\.example\.com\/api\/provider-input\//);
        const signed = new URL(await publishProviderInput(source, "image/jpeg"));
        assert.equal(signed.origin, "https://studio.example.com");
        const filename = signed.pathname.split("/").at(-1)!;
        const expires = signed.searchParams.get("expires");
        const signature = signed.searchParams.get("signature");
        assert.deepEqual((await readProviderInput(filename, expires, signature))?.data, source);
        assert.equal(await readProviderInput(filename, expires, "0".repeat(64)), null);
        assert.equal(await readProviderInput(filename, String(Number(expires) - 1), signature), null);
        assert.equal(await readProviderInput("../../master-key.json", expires, signature), null);

        const { GET, HEAD } = await import("../src/app/api/provider-input/[filename]/route");
        const { default: proxy } = await import("../src/proxy");
        const context = { params: Promise.resolve({ filename }) };
        const entry = await proxy(new NextRequest(signed));
        assert.equal(entry.status, 200, "the auth proxy permits only signed-media reads to reach the route");
        const get = await GET(new NextRequest(signed), context);
        assert.equal(get.status, 200);
        assert.equal(get.headers.get("content-type"), "image/jpeg");
        assert.deepEqual(Buffer.from(await get.arrayBuffer()), source);
        const head = await HEAD(new NextRequest(signed, { method: "HEAD" }), context);
        assert.equal(head.status, 200);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const forged = new URL(signed);
        forged.searchParams.set("signature", "0".repeat(64));
        assert.equal((await GET(new NextRequest(forged), context)).status, 404);
    } finally {
        if (originalStorage === undefined) delete process.env.OPEN_HIGGSFIELD_STORAGE_DIR;
        else process.env.OPEN_HIGGSFIELD_STORAGE_DIR = originalStorage;
        if (originalOrigin === undefined) delete process.env.OPEN_HIGGSFIELD_APP_ORIGIN;
        else process.env.OPEN_HIGGSFIELD_APP_ORIGIN = originalOrigin;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
