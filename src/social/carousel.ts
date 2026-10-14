import type { ImageModelCapability } from "@/models/capabilities/image";
import type { BrandSystem, CarouselSlide, SocialProject } from "./types";
import { brandIdentityPrompt } from "./brand";

export const CAROUSEL_ROLES = ["Portada", "Problema", "Idea clave", "Solución", "Beneficio", "Prueba", "Consejo", "Resumen", "Ejemplo", "Llamada a la acción"];

export function carouselRoles(count: number): string[] {
    if (count < 2 || count > 10) throw new Error("El carrusel debe tener entre 2 y 10 páginas.");
    if (count === 2) return ["Portada", "Llamada a la acción"];
    return ["Portada", ...Array.from({ length: count - 2 }, (_, index) => CAROUSEL_ROLES[Math.min(index + 1, 8)]), "Llamada a la acción"];
}

export function imageRatios(model: ImageModelCapability): string[] {
    if (model.size_ui) return model.size_ui.aspect_ratios.map(({ w, h }) => `${w}:${h}`);
    const field = model.custom_fields?.find(item => item.id === "aspect_ratio" && item.type === "select");
    if (field?.options?.length) return field.options.map(option => {
        const match = option.match(/_(\d+)_(\d+)$/);
        return match ? `${match[1]}:${match[2]}` : option;
    });
    return model.aspect_ratio !== false ? (model.aspect_ratio.options?.map(([, value]) => value) ?? []) : [];
}

export function imageResolutions(model: ImageModelCapability): string[] {
    if (model.size_ui) return model.size_ui.resolutions.map(item => item.id);
    return model.custom_fields?.find(item => item.id === "resolution" && item.type === "select")?.options ?? [];
}

export function carouselPrompt(project: SocialProject, slide: CarouselSlide, brand: BrandSystem): string {
    const slides = project.slides ?? [];
    const position = slides.findIndex(item => item.id === slide.id);
    if (position < 0) throw new Error("La diapositiva no pertenece al carrusel.");
    const autoCopy = !slide.title.trim();
    return [
        `Diseña la diapositiva ${position + 1} de ${slides.length} de un carrusel social en formato ${project.aspectRatio}.`,
        `Campaña: ${project.brief}. Función narrativa de esta página: ${slide.role}.`,
        autoCopy
            ? `Redacta e integra en la imagen un titular breve y legible en ${project.language}, y como máximo una frase de apoyo. La portada presenta el tema, las páginas intermedias desarrollan una idea diferente siguiendo su función narrativa y la última cierra con una llamada a la acción. No repitas el mismo titular ni conviertas esta página en un collage de otras. Respeta los datos del encargo; no inventes cifras, ofertas ni testimonios.`
            : `TEXTO VISIBLE EXACTO EN ${project.language.toUpperCase()}:\nTitular: ${slide.title.trim()}\n${slide.body.trim() ? `Texto secundario: ${slide.body.trim()}` : "No agregues texto secundario."}`,
        "No añadas logotipos inventados ni texto de otras diapositivas. Comprueba la ortografía.",
        `Dirección visual específica: ${slide.visualPrompt.trim() || "Composición clara y legible, adecuada a la función de esta página."}`,
        brandIdentityPrompt(brand),
        slide.sourceTaskId
            ? `La imagen adjunta es la MISMA página del carrusel original en otro formato. Conserva sujetos, producto, objetos, paleta, identidad y mensaje. Recompón la escena para el nuevo lienzo sin estirar ni recortar texto. ${autoCopy ? "Conserva el mensaje y el texto de la referencia sin inventar contenido nuevo." : "Recrea únicamente el texto exacto indicado arriba; no copies letras de la referencia."}`
            : "Mantén los mismos personajes, producto, paleta y estilo de toda la serie. La imagen de referencia, si existe, sirve para identidad visual, NO para copiar su texto. Recompón el diseño para este lienzo, con márgenes seguros y texto legible.",
    ].filter(Boolean).join("\n\n");
}
