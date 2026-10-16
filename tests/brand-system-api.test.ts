import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { brandSaveInput } from "../src/social/brand";

test("design systems persist references and prohibitions, validate mentions, and update existing brands", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-brand-api-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    process.env.OPEN_HIGGSFIELD_APP_ORIGIN = "http://localhost:3000";
    process.env.OPEN_HIGGSFIELD_SETUP_TOKEN = crypto.randomUUID();
    delete process.env.WORKFLOWS_DATABASE_URL;
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const auth = await import("../src/lib/admin-auth");
    await auth.initializeAdminSetup();
    const admin = await auth.createAdmin("test-brand-password-only-123456", process.env.OPEN_HIGGSFIELD_SETUP_TOKEN);
    const { NextRequest } = await import("next/server");
    const { POST, GET } = await import("../src/app/api/social/route");
    const { saveAsset } = await import("../src/workflows/assets");
    const image = await saveAsset(await sharp({ create: { width: 20, height: 20, channels: 4, background: "#ffffff00" } }).png().toBuffer(), "image");
    const headers = { "Content-Type": "application/json", Origin: "http://localhost:3000", Cookie: `${auth.COOKIE_NAME}=${admin.token}` };
    const post = (brand: unknown, cookie = headers.Cookie) => POST(new NextRequest("http://localhost:3000/api/social", { method: "POST", headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ action: "save-brand", brand }) }));
    const draft = { name: "Prueba", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#ff0000", headingFont: "Inter", bodyFont: "Inter", voice: "Clara", visualRules: "Composición de @ejemplo", references: [{ assetId: image.id, name: "ejemplo" }], negativePrompt: "No añadir texto inventado", logoAssetIds: [image.id] };
    assert.equal((await post(draft, "")).status, 401);
    const created = await post(draft); assert.equal(created.status, 200);
    const saved = (await created.json()).brand;
    assert.equal(saved.subheadingFont, draft.headingFont);
    assert.equal(saved.secondaryBodyFont, draft.bodyFont);
    const fourFonts = await post(brandSaveInput({ ...saved, subheadingFont: "Oswald", secondaryBodyFont: "Lora" }));
    assert.equal(fourFonts.status, 200);
    Object.assign(saved, (await fourFonts.json()).brand);
    const edited = await post(brandSaveInput({ ...saved, name: "Editada" })); assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).brand.references, draft.references);
    assert.equal((await post({ ...draft, references: [...draft.references, ...draft.references] })).status, 400);
    assert.equal((await post({ ...draft, visualRules: "Usa @noexiste" })).status, 400);
    assert.equal((await post({ ...draft, references: [{ name: "ejemplo", assetId: crypto.randomUUID() }] })).status, 400);
    assert.equal((await post({ ...draft, references: [{ name: "<script>", assetId: image.id }] })).status, 400);
    assert.equal((await post({ ...draft, negativePrompt: "x".repeat(2001) })).status, 400);
    // An older client omitting the new fields must not erase them.
    const legacy = brandSaveInput(saved); delete legacy.references; delete legacy.negativePrompt; delete legacy.subheadingFont; delete legacy.secondaryBodyFont;
    assert.equal((await post(legacy)).status, 200);
    const reloaded = await GET(new NextRequest("http://localhost:3000/api/social", { headers }));
    const brand = (await reloaded.json()).brands.find((item: { id: string }) => item.id === saved.id);
    assert.deepEqual(brand.references, draft.references); assert.equal(brand.negativePrompt, draft.negativePrompt);
    assert.equal(brand.subheadingFont, "Oswald"); assert.equal(brand.secondaryBodyFont, "Lora");
    assert.equal((await post({ ...draft, subheadingFont: "" })).status, 400);
    assert.equal((await post({ ...draft, secondaryBodyFont: "x".repeat(81) })).status, 400);
    const light = await GET(new NextRequest("http://localhost:3000/api/social?includeAssets=0", { headers }));
    const lightweight = await light.json();
    assert.deepEqual(lightweight.assets, []); assert.equal(lightweight.brands.length, 1);
    // The font catalogue is authenticated and coalesces parallel requests.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ familyMetadataList: [{ family: "Inter" }, { family: "Montserrat" }] })); }) as typeof fetch;
    try {
        const { GET: fonts } = await import("../src/app/api/fonts/route");
        assert.equal((await fonts(new NextRequest("http://localhost:3000/api/fonts"))).status, 401);
        assert.equal(calls, 0);
        const results = await Promise.all([fonts(new NextRequest("http://localhost:3000/api/fonts", { headers })), fonts(new NextRequest("http://localhost:3000/api/fonts", { headers }))]);
        assert.equal(calls, 1);
        assert.deepEqual((await results[0].json()).families, ["Inter", "Montserrat"]);
        await fonts(new NextRequest("http://localhost:3000/api/fonts", { headers }));
        assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
});
