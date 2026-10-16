import type { BrandSystem } from "./types";

export const MAX_BRAND_LOGOS = 8;
export const MAX_BRAND_REFERENCES = 6;

/** Whitelist editable fields: persisted timestamps are not accepted by the API. */
export function brandSaveInput(brand: Omit<BrandSystem, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const { id, name, primaryColor, secondaryColor, accentColor, headingFont, subheadingFont, bodyFont, secondaryBodyFont, voice, visualRules, negativePrompt, references, logoAssetId, logoAssetIds, logoVectorAssetId } = brand;
    return { id, name, primaryColor, secondaryColor, accentColor, headingFont, subheadingFont, bodyFont, secondaryBodyFont, voice, visualRules, negativePrompt, references, logoAssetId, logoAssetIds, logoVectorAssetId };
}

/** Older brands inherit their existing heading/body families without a migration. */
export function brandTypography(brand: Pick<BrandSystem, "headingFont" | "subheadingFont" | "bodyFont" | "secondaryBodyFont">) {
    return { headingFont: brand.headingFont, subheadingFont: brand.subheadingFont || brand.headingFont,
        bodyFont: brand.bodyFont, secondaryBodyFont: brand.secondaryBodyFont || brand.bodyFont };
}

export function brandTypographyPrompt(brand: BrandSystem): string {
    const fonts = brandTypography(brand);
    return `Tipografías: título principal ${fonts.headingFont}; título secundario ${fonts.subheadingFont}; texto 1 (cuerpo principal) ${fonts.bodyFont}; texto 2 (apoyos y notas) ${fonts.secondaryBodyFont}. Mantén esta jerarquía tipográfica.`;
}

export function brandImageAssetIds(brand: BrandSystem): string[] {
    return [...new Set([...brandLogoAssetIds(brand), ...(brand.references ?? []).map(item => item.assetId)])];
}

/** Include the original single-logo field when reading older design systems. */
export function brandLogoAssetIds(brand: Pick<BrandSystem, "logoAssetId" | "logoAssetIds">): string[] {
    return [...new Set([...(brand.logoAssetIds ?? []), ...(brand.logoAssetId ? [brand.logoAssetId] : [])])];
}

export function brandIdentityPrompt(brand: BrandSystem): string {
    const logoCount = brandLogoAssetIds(brand).length;
    return [
        `Identidad visual de marca: ${brand.name}.`,
        `Colores: principal ${brand.primaryColor}; secundario ${brand.secondaryColor}; acento ${brand.accentColor}.`,
        brandTypographyPrompt(brand),
        brand.voice ? `Tono: ${brand.voice}.` : "",
        brand.visualRules ? `Reglas visuales: ${brand.visualRules}.` : "",
        ...(brand.references ?? []).map(item => `@${item.name}: imagen de inspiración adjunta y rotulada @${item.name}. Aplica las reglas que la mencionan; no copies sus textos, logos ni la etiqueta de referencia salvo petición explícita.`),
        brand.negativePrompt?.trim() ? `PROHIBICIONES DE MARCA (aplican a toda la pieza):\n${brand.negativePrompt.trim()}` : "",
        logoCount ? `Usa ${logoCount === 1 ? "el logo adjunto" : `los ${logoCount} logos adjuntos`} como referencias visuales de la marca e incorpóralos en el posteo sin inventar otros ni cambiar sus formas, colores o texto. Si se adjunta una hoja de referencias, no reproduzcas sus divisiones ni márgenes.` : "",
        "Respeta esta identidad de forma coherente. Conserva el idioma y el texto solicitado en el prompt.",
    ].filter(Boolean).join("\n");
}
