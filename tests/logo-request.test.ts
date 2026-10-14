import assert from "node:assert/strict";
import test from "node:test";
import { buildLogoPrompt, logoCommand } from "../src/social/logo-request";
import type { BrandSystem } from "../src/social/types";

const sourceAssetId = "123e4567-e89b-42d3-a456-426614174000";
const brandId = "123e4567-e89b-42d3-a456-426614174001";

test("logo creation, redraw and tracing allow no design system", () => {
    const create = logoCommand.parse({ mode: "create", modelId: "recraft/vector", prompt: "Logo para una bodega de vinos", count: 1 });
    const redraw = logoCommand.parse({ mode: "redraw", modelId: "recraft/vector", prompt: "Simplifica esta marca de vinos", count: 1, sourceAssetId });
    const trace = logoCommand.parse({ mode: "trace", sourceAssetId, colors: 8 });
    assert.equal(create.brandId, undefined);
    assert.equal(redraw.brandId, undefined);
    assert.equal(trace.brandId, undefined);
    assert.equal(logoCommand.parse({ mode: "create", brandId, modelId: "recraft/vector", prompt: "Logo para una bodega de vinos", count: 1 }).brandId, brandId);
    assert.equal(logoCommand.safeParse({ mode: "create", brandId: "", modelId: "recraft/vector", prompt: "Logo para una bodega de vinos", count: 1 }).success, false);
});

test("logo prompt adds brand styling only when explicitly selected", () => {
    const input = { mode: "create" as const, prompt: "Logo para Rionegró, una empresa de vinos" };
    const withoutBrand = buildLogoPrompt(input);
    assert.match(withoutBrand, /Rionegró/);
    assert.match(withoutBrand, /scalable vector logo/);
    assert.doesNotMatch(withoutBrand, /Brand:|Palette:/);

    const brand = { id: brandId, name: "Mi marca", primaryColor: "#111111", secondaryColor: "#eeeeee", accentColor: "#ff0000", visualRules: "Minimalismo" } as BrandSystem;
    const withBrand = buildLogoPrompt(input, brand);
    assert.match(withBrand, /Brand: Mi marca/);
    assert.match(withBrand, /#111111/);
});
