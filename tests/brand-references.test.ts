import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ImageModelCapability } from "../src/models/capabilities/image";
import { brandIdentityPrompt, brandLogoAssetIds } from "../src/social/brand";
import type { BrandSystem } from "../src/social/types";

test("a design system passes every logo to image generation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-brand-refs-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = dir;
    delete process.env.WORKFLOWS_DATABASE_URL;
    try {
        const { saveAsset } = await import("../src/workflows/assets");
        const { attachBrandImageReferences, referenceSheetValue } = await import("../src/social/references");
        const red = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#e00000" } }).png().toBuffer();
        const blue = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#0000e0" } }).png().toBuffer();
        const first = await saveAsset(red, "image");
        const second = await saveAsset(blue, "image");
        const brand: BrandSystem = {
            id: crypto.randomUUID(), name: "Marca", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#e00000",
            headingFont: "Inter", bodyFont: "Arial", voice: "Cercana", visualRules: "Alto contraste",
            logoAssetIds: [first.id, second.id], logoAssetId: first.id, createdAt: 1, updatedAt: 1,
        };
        assert.deepEqual(brandLogoAssetIds(brand), [first.id, second.id]);
        assert.match(brandIdentityPrompt(brand), /los 2 logos adjuntos/);
        assert.match(brandIdentityPrompt(brand), /Alto contraste/);

        const model = { media_slots: [{ id: "reference", label: "Referencia", kind: "image" }] } as ImageModelCapability;
        const single = new FormData();
        single.append("slot_reference", new File([new Uint8Array(red)], "post-original.png", { type: "image/png" }));
        await attachBrandImageReferences(single, model, brand);
        const sheet = single.getAll("slot_reference") as File[];
        assert.equal(sheet.length, 1);
        const metadata = await sharp(Buffer.from(await sheet[0].arrayBuffer())).metadata();
        assert.ok((metadata.width ?? 0) > 1000);
        assert.ok((metadata.height ?? 0) > 0);
        const blueLogoPixel = await sharp(Buffer.from(await sheet[0].arrayBuffer()))
            .extract({ left: 1350, top: 275, width: 1, height: 1 }).raw().toBuffer();
        assert.ok(blueLogoPixel[2] > blueLogoPixel[0]);

        const workflowSheet = await referenceSheetValue([first.id, second.id], "openrouter");
        assert.match(workflowSheet, /^data:image\/jpeg;base64,/);

        const multi = new FormData();
        await attachBrandImageReferences(multi, { ...model, media_slots: [{ ...model.media_slots[0], multiple: true }] }, brand);
        assert.equal(multi.getAll("slot_reference").length, 2);
        await assert.rejects(attachBrandImageReferences(new FormData(), { ...model, media_slots: [] }, brand), /no admite imágenes/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
