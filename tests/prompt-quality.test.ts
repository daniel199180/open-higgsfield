import test from "node:test";
import assert from "node:assert/strict";
import { withOrthographyReview } from "../src/lib/prompt-quality";

test("generation prompts always request an orthography review without changing exact copy", () => {
    const prompt = withOrthographyReview("Diseña un anuncio con el texto exacto «Tienda Ya». ");
    assert.match(prompt, /revisa la ortografía, la gramática y la acentuación/i);
    assert.match(prompt, /Conserva literalmente nombres propios, marcas, URLs/i);
    assert.match(prompt, /Tienda Ya/);
});

test("orthography review is not duplicated and respects provider prompt limits", () => {
    const reviewed = withOrthographyReview("Comprueba la ortografía antes de generar.");
    assert.equal(reviewed.match(/ortograf/gi)?.length, 1);
    assert.match(withOrthographyReview("Representa un cartel con mala ortografía deliberada."), /Control de calidad:/);
    const compact = withOrthographyReview("A".repeat(70), 120);
    assert.match(compact, /Revisa la ortografía de todo texto visible\.$/);
    assert.ok(compact.length <= 120);
    assert.equal(withOrthographyReview("A".repeat(120), 120), "A".repeat(120));
});
