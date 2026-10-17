import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { carouselBriefForSlide, carouselRoles, carouselPrompt, imageRatios } from "../src/social/carousel";
import { carouselDimensions, imagesPdf, imagesZip } from "../src/social/carousel-export";
import type { BrandSystem, SocialProject } from "../src/social/types";
import { IMAGE_CAPABILITIES } from "../src/models/capabilities/image";
import { isCarouselModel } from "../src/social/carousel-models";
import type { ImageModelCapability } from "../src/models/capabilities/image";

test("carousel storyboard has a cover and CTA, with one ordered role per page", () => {
    assert.deepEqual(carouselRoles(2), ["Portada", "Llamada a la acción"]);
    assert.equal(carouselRoles(6).length, 6);
    assert.equal(carouselRoles(6)[5], "Llamada a la acción");
    assert.throws(() => carouselRoles(11));
});

test("carousel prompt isolates each page's exact copy and preserves brand instructions", () => {
    const brand: BrandSystem = { id: "brand", name: "ISO", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#4fc3ff", headingFont: "Montserrat", bodyFont: "Inter", voice: "Claro", visualRules: "Alto contraste", createdAt: 1, updatedAt: 1 };
    const project: SocialProject = { id: "project", name: "Campaña", brandId: brand.id, format: "carousel", language: "Español", brief: "Vender software", modelId: "model", aspectRatio: "4:5", resolution: "1k", slideCount: 2, taskIds: [], status: "draft", createdAt: 1, updatedAt: 1, slides: [{ id: "a", role: "Portada", title: "Tu idea", body: "", visualPrompt: "Oficina", taskIds: [] }, { id: "b", role: "Llamada a la acción", title: "Hablemos", body: "Hoy", visualPrompt: "Equipo", taskIds: [] }] };
    const prompt = carouselPrompt(project, project.slides![1], brand);
    assert.match(prompt, /diapositiva 2 de 2/);
    assert.match(prompt, /Titular: Hablemos/);
    assert.doesNotMatch(prompt, /Tu idea/);
    assert.match(prompt, /#4fc3ff/);
});

test("carousel chat prompt lets the image model write distinct copy for an empty page", () => {
    const brand: BrandSystem = { id: "brand", name: "ISO", primaryColor: "#000000", secondaryColor: "#ffffff", accentColor: "#4fc3ff", headingFont: "Montserrat", bodyFont: "Inter", voice: "Claro", visualRules: "Alto contraste", createdAt: 1, updatedAt: 1 };
    const project: SocialProject = { id: "project", name: "Campaña", brandId: brand.id, format: "carousel", language: "Español", brief: "Explica las ventajas de vender con una página web", modelId: "model", aspectRatio: "4:5", resolution: "1k", slideCount: 2, taskIds: [], status: "draft", createdAt: 1, updatedAt: 1, slides: [{ id: "a", role: "Portada", title: "", body: "", visualPrompt: "", taskIds: [] }, { id: "b", role: "Llamada a la acción", title: "", body: "", visualPrompt: "", taskIds: [] }] };
    const prompt = carouselPrompt(project, project.slides![1], brand);
    assert.match(prompt, /diapositiva 2 de 2/);
    assert.match(prompt, /Redacta e integra/);
    assert.match(prompt, /llamada a la acción/i);
    assert.doesNotMatch(prompt, /Titular:\s*$/m);
});

test("a structured brief sends each generation only its matching slide", () => {
    const brief = [
        "Reglas generales: mantén la marca y no inventes datos.",
        "LÁMINA 1 — PORTADA\nTexto exacto: Bienvenida",
        "LÁMINA 2 — BENEFICIO\nTexto exacto: Más claridad",
        "LÁMINA 3 — CTA\nTexto exacto: Escríbenos",
    ].join("\n\n");
    const second = carouselBriefForSlide(brief, 1);
    assert.equal(second.structured, true);
    assert.match(second.content, /Reglas generales/);
    assert.match(second.content, /LÁMINA 2/);
    assert.doesNotMatch(second.content, /LÁMINA 1|LÁMINA 3/);
});

test("ratio helpers only expose supported canvases", () => {
    const model = IMAGE_CAPABILITIES["v1__ai__text_to_image__flux_2_klein"];
    assert.ok(imageRatios(model).includes("4:5"));
    assert.deepEqual(carouselDimensions("4:5"), { width: 1080, height: 1350 });
    assert.throws(() => carouselDimensions("auto"));
});

test("carousel accepts GPT Image and Nano Banana from OpenRouter or APIMart despite incomplete catalog metadata", () => {
    const base: ImageModelCapability = {
        id: "runtime", label: "Runtime", family: "OpenRouter", variant: "", group: "OpenRouter", provider: "openrouter", provider_model_id: "google/gemini-3.1-flash-image", provider_connection_id: "connection", provider_mode: "native-image", prompt_required: true, prompt_supported: true,
        duration: false, aspect_ratio: { options: [["1:1", "1:1"]], default: ["1:1", "1:1"] }, size: false, resolution_variant: false, negative_prompt: false, cfg_scale: false, style: false, shot_type: false, prompt_expansion: false, elements: false,
        media_slots: [{ id: "input_references", label: "References", kind: "image", multiple: true }], custom_fields: [], has_edit_variant: false,
    };
    assert.equal(isCarouselModel(base), true);
    assert.equal(isCarouselModel({ ...base, provider: "apimart", provider_model_id: "gpt-image-2.5", label: "GPT Image 2.5", media_slots: [] }), true);
    assert.equal(isCarouselModel({ ...base, provider: "apimart", provider_model_id: "nano-banana-pro", label: "Nano Banana Pro", media_slots: [] }), true);
    assert.equal(isCarouselModel({ ...base, provider_model_id: "bytedance-seed/seedream-4.5" }), false);
});

test("carousel ZIP and PDF contain ordered pages without paid generation", async () => {
    const image = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#4fc3ff" } }).jpeg().toBuffer();
    const files = [{ name: "pagina-01.jpg", jpeg: image }, { name: "pagina-02.jpg", jpeg: image }];
    const zip = imagesZip(files);
    const pdf = imagesPdf(files, 1080, 1350);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from("pagina-02.jpg")));
    assert.match(pdf.toString("latin1", 0, 200), /%PDF-1\.4/);
    assert.ok(pdf.includes(Buffer.from("/Count 2")));
    assert.ok(pdf.includes(Buffer.from("/MediaBox [0 0 1080 1350]")));
});
