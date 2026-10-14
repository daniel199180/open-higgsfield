import "server-only";
import sharp from "sharp";
import type { OutpaintLayout, OutpaintPlan } from "@/lib/image-outpaint";

/** A transparent border plus the original at its intended position gives the model a spatial reference. */
export async function makeOutpaintGuide(source: Buffer, layout: OutpaintLayout): Promise<Buffer> {
    // Scale only the guide sent to the provider. Keep the original unscaled for optional pixel locking.
    const scale = Math.min(1, 2048 / Math.max(layout.width, layout.height), Math.sqrt(4_000_000 / (layout.width * layout.height)));
    const width = Math.max(1, Math.round(layout.width * scale));
    const height = Math.max(1, Math.round(layout.height * scale));
    const sourceWidth = Math.max(1, Math.round(layout.sourceWidth * scale));
    const sourceHeight = Math.max(1, Math.round(layout.sourceHeight * scale));
    const left = Math.max(0, Math.min(width - sourceWidth, Math.round(layout.left * scale)));
    const top = Math.max(0, Math.min(height - sourceHeight, Math.round(layout.top * scale)));
    const placed = await sharp(source).resize(sourceWidth, sourceHeight, { fit: "fill" }).png().toBuffer();
    return sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
        .composite([{ input: placed, left, top }]).png().toBuffer();
}

/** Preserve the source pixels exactly; generated pixels are used only outside its rectangle. */
export async function finishOutpaint(generated: Buffer, original: Buffer, plan: OutpaintPlan, preserveOriginal: boolean): Promise<Buffer> {
    const background = await sharp(generated, { limitInputPixels: 40_000_000, failOn: "error" })
        .resize(plan.provider.width, plan.provider.height, { fit: "cover" })
        .extract({ left: plan.cropLeft, top: plan.cropTop, width: plan.target.width, height: plan.target.height })
        .png().toBuffer();
    return preserveOriginal ? sharp(background).composite([{ input: original, left: plan.target.left, top: plan.target.top }]).png().toBuffer() : background;
}

/** Legacy helper retained for the initial ratio-based expansion tests and callers. */
export async function lockOutpaintOriginal(generated: Buffer, original: Buffer, layout: OutpaintLayout): Promise<Buffer> {
    return finishOutpaint(generated, original, { target: layout, provider: layout, cropLeft: 0, cropTop: 0, ratio: "1:1" }, true);
}
