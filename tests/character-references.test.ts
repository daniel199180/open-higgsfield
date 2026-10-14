import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ImageModelCapability } from "../src/models/capabilities/image";
import { characterIdentityPrompt, characterSnapshot } from "../src/social/characters";
import type { BrandSystem, Character } from "../src/social/types";

test("character and brand references all reach a multi-reference image input", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-character-refs-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = dir;
    delete process.env.WORKFLOWS_DATABASE_URL;
    try {
        const { saveAsset } = await import("../src/workflows/assets");
        const { attachBrandImageReferences, attachCharacterImageReferences } = await import("../src/social/references");
        const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#d92f38" } }).png().toBuffer();
        const ids = await Promise.all(Array.from({ length: 4 }, async () => (await saveAsset(png, "image")).id));
        const character: Character = { id: crypto.randomUUID(), name: "Luna", description: "Cabello castaño y chaqueta roja", visualRules: "Misma identidad facial", referenceAssetIds: ids.slice(0, 2), coverAssetId: ids[0], version: 2, createdAt: 1, updatedAt: 2 };
        const brand: BrandSystem = { id: crypto.randomUUID(), name: "Marca", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#d92f38", headingFont: "Inter", bodyFont: "Inter", voice: "", visualRules: "", logoAssetIds: ids.slice(2), createdAt: 1, updatedAt: 1 };
        const model = { provider: "google-ai-studio", media_slots: [{ id: "input_references", kind: "image", label: "References", multiple: true }] } as ImageModelCapability;
        const form = new FormData();
        await attachBrandImageReferences(form, model, brand);
        await attachCharacterImageReferences(form, model, characterSnapshot(character));
        const files = form.getAll("slot_input_references") as File[];
        assert.equal(files.length, 4);
        assert.deepEqual(files.map(file => file.name), ["brand-logo-1.png", "brand-logo-2.png", "character-1.png", "character-2.png"]);
        const snapshot = characterSnapshot(character);
        character.referenceAssetIds = [ids[1]];
        assert.deepEqual(snapshot.referenceAssetIds, ids.slice(0, 2));
        assert.match(characterIdentityPrompt(snapshot), /Luna/);
        const single = { ...model, media_slots: [{ id: "input", kind: "image", label: "Image" }] } as ImageModelCapability;
        await assert.rejects(attachCharacterImageReferences(new FormData(), single, snapshot), /entradas suficientes/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
