const FULL_REVIEW = "Control de calidad: antes de generar, revisa la ortografía, la gramática y la acentuación de todo texto visible. Conserva literalmente nombres propios, marcas, URLs, usuarios, hashtags, códigos y cualquier texto indicado como exacto; no inventes palabras.";
const COMPACT_REVIEW = "Revisa la ortografía de todo texto visible.";

export function withOrthographyReview(prompt: string, maxLength = Number.POSITIVE_INFINITY): string {
    const value = prompt.trim();
    const alreadyRequestsReview = /\b(?:revisa|comprueba|corrige)\b.{0,80}\bortograf/i.test(value)
        || /revisi[oó]n (?:de la )?ortograf/i.test(value);
    if (!value || alreadyRequestsReview) return value;
    for (const instruction of [FULL_REVIEW, COMPACT_REVIEW]) {
        const reviewed = `${value}\n\n${instruction}`;
        if (reviewed.length <= maxLength) return reviewed;
    }
    return value;
}
