export const OUTPAINT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;
export type OutpaintRatio = (typeof OUTPAINT_RATIOS)[number];
export const OUTPAINT_PLACEMENTS = ["center", "top", "bottom", "left", "right"] as const;
export type OutpaintPlacement = (typeof OUTPAINT_PLACEMENTS)[number];

export interface OutpaintLayout {
    width: number;
    height: number;
    left: number;
    top: number;
    sourceWidth: number;
    sourceHeight: number;
}

export interface OutpaintPadding { left: number; right: number; top: number; bottom: number }
export type OutpaintSide = keyof OutpaintPadding;
export interface OutpaintPlan {
    target: OutpaintLayout;
    provider: OutpaintLayout;
    cropLeft: number;
    cropTop: number;
    ratio: OutpaintRatio;
}

/** The user-defined border is exact. Extra space needed by the model is generated, then cropped away. */
export function planOutpaint(sourceWidth: number, sourceHeight: number, padding: OutpaintPadding, supportedRatios: readonly string[]): OutpaintPlan {
    if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 ||
        ![padding.left, padding.right, padding.top, padding.bottom].every((value) => Number.isInteger(value) && value >= 0) ||
        padding.left > sourceWidth || padding.right > sourceWidth || padding.top > sourceHeight || padding.bottom > sourceHeight ||
        !Object.values(padding).some((value) => value > 0)) throw new Error("Arrastra al menos un borde dentro del tamaño permitido.");
    const target: OutpaintLayout = {
        width: sourceWidth + padding.left + padding.right,
        height: sourceHeight + padding.top + padding.bottom,
        left: padding.left, top: padding.top, sourceWidth, sourceHeight,
    };
    const choices = supportedRatios.filter((ratio): ratio is OutpaintRatio => OUTPAINT_RATIOS.includes(ratio as OutpaintRatio)).map((ratio) => {
        const [rw, rh] = ratio.split(":").map(Number);
        const scale = Math.max(target.width / rw, target.height / rh);
        const width = Math.ceil(scale * rw);
        const height = Math.ceil(scale * rh);
        const cropLeft = Math.floor((width - target.width) / 2);
        const cropTop = Math.floor((height - target.height) / 2);
        return {
            ratio, target, cropLeft, cropTop,
            provider: { width, height, left: cropLeft + padding.left, top: cropTop + padding.top, sourceWidth, sourceHeight },
        };
    }).filter((plan) => plan.provider.width * plan.provider.height <= 16_000_000);
    choices.sort((a, b) => a.provider.width * a.provider.height - b.provider.width * b.provider.height);
    if (!choices.length) throw new Error("El área ampliada no cabe en un formato compatible del modelo (máximo 16 MP).");
    return choices[0];
}

export function calculateOutpaintLayout(sourceWidth: number, sourceHeight: number, ratio: OutpaintRatio, expansion: number, placement: OutpaintPlacement): OutpaintLayout {
    if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 ||
        !OUTPAINT_RATIOS.includes(ratio) || !OUTPAINT_PLACEMENTS.includes(placement) || !Number.isInteger(expansion) || expansion < 10 || expansion > 100) {
        throw new Error("Opciones de expansión inválidas.");
    }
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
    const factor = Math.max(sourceWidth * (1 + expansion / 100) / ratioWidth, sourceHeight * (1 + expansion / 100) / ratioHeight);
    const width = Math.max(sourceWidth + 1, Math.ceil(factor * ratioWidth));
    const height = Math.max(sourceHeight + 1, Math.ceil(factor * ratioHeight));
    const left = placement === "left" ? 0 : placement === "right" ? width - sourceWidth : Math.floor((width - sourceWidth) / 2);
    const top = placement === "top" ? 0 : placement === "bottom" ? height - sourceHeight : Math.floor((height - sourceHeight) / 2);
    return { width, height, left, top, sourceWidth, sourceHeight };
}

