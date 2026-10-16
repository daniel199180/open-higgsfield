import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ImageModelCapability } from "../src/models/capabilities/image";
import { brandIdentityPrompt, brandLogoAssetIds, brandSaveInput } from "../src/social/brand";
import type { BrandSystem } from "../src/social/types";

test("a design system passes every logo to image generation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-brand-refs-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = dir;
    delete process.env.WORKFLOWS_DATABASE_URL;
    try {
        const { saveAsset, readAsset } = await import("../src/workflows/assets");
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
        assert.match(workflowSheet, /^data:image\/png;base64,/);

        const multi = new FormData();
        await attachBrandImageReferences(multi, { ...model, media_slots: [{ ...model.media_slots[0], multiple: true }] }, brand);
        assert.equal(multi.getAll("slot_reference").length, 2);
        await assert.rejects(attachBrandImageReferences(new FormData(), { ...model, media_slots: [] }, brand), /no admite imágenes/);

        const transparent = await sharp({ create: { width: 80, height: 80, channels: 4, background: "#00000000" } }).composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: "white" } }).png().toBuffer(), left: 20, top: 20 }]).png().toBuffer();
        const whiteLogo = await saveAsset(transparent, "image");
        const withReferences: BrandSystem = { ...brand, logoAssetId: whiteLogo.id, logoAssetIds: [whiteLogo.id], references: [{ assetId: second.id, name: "composicion" }], visualRules: "Usar @composicion para distribuir los elementos", negativePrompt: "No inventar precios ni modificar el logo." };
        const prompt = brandIdentityPrompt(withReferences);
        assert.match(prompt, /@composicion: imagen de inspiración/);
        assert.match(prompt, /PROHIBICIONES DE MARCA/);
        assert.match(prompt, /No inventar precios/);
        assert.equal("createdAt" in brandSaveInput(withReferences), false);
        assert.equal("updatedAt" in brandSaveInput(withReferences), false);
        const enriched = new FormData();
        await attachBrandImageReferences(enriched, { ...model, media_slots: [{ ...model.media_slots[0], multiple: true }] }, withReferences);
        const inputs = enriched.getAll("slot_reference") as File[];
        assert.equal(inputs.length, 2);
        assert.deepEqual(Buffer.from(await inputs[0].arrayBuffer()), (await readAsset(whiteLogo.id)).data, "the original transparent logo is sent unchanged");
        const { data: pixels, info } = await sharp(Buffer.from(await inputs[0].arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.channels, 4); assert.equal(pixels[3], 0); assert.equal(pixels[(40 * 80 + 40) * 4 + 3], 255);
        assert.equal(inputs[1].name, "reference-composicion.png");
        assert.equal((await sharp(Buffer.from(await inputs[1].arrayBuffer())).metadata()).height, 128);
        const whiteSheet = await referenceSheetValue([whiteLogo.id, second.id], "openrouter");
        const decoded = Buffer.from(whiteSheet.split(",")[1], "base64");
        const sample = async (left: number, top: number) => sharp(decoded).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
        assert.equal((await sample(280, 280))[0], 255, "white logo stays visible");
        assert.equal((await sample(30, 30))[0], 128, "transparent area gets neutral contrast only in the derived sheet");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
