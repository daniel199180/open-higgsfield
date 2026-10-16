import type { ImageLayerMetadata, ImageLayerSet } from "@/types";

export function hasReliableLayerLayout(set: ImageLayerSet): boolean {
    const width = set.canvasWidth ?? set.sourceWidth;
    const height = set.canvasHeight ?? set.sourceHeight;
    return width > 0 && height > 0 && set.layers.length > 0 && set.layers.every(layer => {
        if (layer.index === set.referenceIndex || layer.index === set.baseIndex) return true;
        const [left, top, right, bottom] = layer.boundingBox.absolute;
        return ["absolute", "normalized", "alpha"].includes(layer.boundingBoxSource ?? "") &&
            [left, top, right, bottom].every(Number.isFinite) && left >= 0 && top >= 0 && right > left && bottom > top && right <= width + 1 && bottom <= height + 1;
    });
}

/** Geometry shared by selection handles and the preview/export renderer. */
export function layerFrame(layer: ImageLayerMetadata, set: ImageLayerSet, transform = { x: 0, y: 0, scale: 1 }) {
    const width = set.canvasWidth ?? set.sourceWidth;
    const height = set.canvasHeight ?? set.sourceHeight;
    const [left, top, right, bottom] = set.version >= 2 ? layer.boundingBox.absolute : [0, 0, width, height];
    const w = right - left; const h = bottom - top;
    return {
        left: left + transform.x * width / 100 + w * (1 - transform.scale) / 2,
        top: top + transform.y * height / 100 + h * (1 - transform.scale) / 2,
        width: w * transform.scale, height: h * transform.scale,
    };
}
