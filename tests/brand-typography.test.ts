import test from "node:test";
import assert from "node:assert/strict";
import { brandTypography, brandTypographyPrompt, brandSaveInput } from "../src/social/brand";
import type { BrandSystem } from "../src/social/types";
import { fontFamilyStyle, googleFontCssUrl, googleFontFamilies } from "../src/lib/google-fonts";

const legacy: BrandSystem = { id: "test", name: "Brand", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#ff0000", headingFont: "Montserrat", bodyFont: "Inter", voice: "", visualRules: "", createdAt: 1, updatedAt: 1 };

test("old brands inherit the original families for the two new roles", () => {
    assert.deepEqual(brandTypography(legacy), { headingFont: "Montserrat", subheadingFont: "Montserrat", bodyFont: "Inter", secondaryBodyFont: "Inter" });
});

test("all four typography roles survive saving and are sent in brand instructions", () => {
    const brand = { ...legacy, subheadingFont: "Oswald", secondaryBodyFont: "Lora" };
    const saved = brandSaveInput(brand);
    assert.equal(saved.subheadingFont, "Oswald"); assert.equal(saved.secondaryBodyFont, "Lora");
    const prompt = brandTypographyPrompt(brand);
    for (const font of ["Montserrat", "Inter", "Oswald", "Lora"]) assert.ok(prompt.includes(font));
});

test("Google font catalog deduplicates and excludes malformed families", () => {
    assert.deepEqual(googleFontFamilies({ familyMetadataList: [{ family: "Inter" }, { family: "Lora" }, { family: "Inter" }, null, { family: 'bad&family=evil' }, { family: 1 }] }), ["Inter", "Lora"]);
    assert.deepEqual(googleFontFamilies(null), []);
    assert.equal(googleFontCssUrl("Playfair Display"), "https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap");
    assert.equal(googleFontCssUrl('";url(https://evil.test)'), null);
    assert.equal(fontFamilyStyle('";color:red'), "system-ui, sans-serif");
});
