import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { carouselRoles, carouselPrompt, imageRatios } from "../src/social/carousel";
import { carouselDimensions, imagesPdf, imagesZip } from "../src/social/carousel-export";
import type { BrandSystem, SocialProject } from "../src/social/types";
import { IMAGE_CAPABILITIES } from "../src/models/capabilities/image";

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

test("ratio helpers only expose supported canvases", () => {
    const model = IMAGE_CAPABILITIES["v1__ai__text_to_image__flux_2_klein"];
    assert.ok(imageRatios(model).includes("4:5"));
    assert.deepEqual(carouselDimensions("4:5"), { width: 1080, height: 1350 });
    assert.throws(() => carouselDimensions("auto"));
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
