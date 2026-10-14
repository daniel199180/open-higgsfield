import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest } from "@/lib/api-security";
import { workflowStore } from "@/workflows/store";
import type { SocialProject } from "@/social/types";
import { carouselDimensions, finishedCarouselImages, imagesPdf, imagesZip } from "@/social/carousel-export";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("carousel-exports", 20); if (limited) return limited;
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Carrusel inválido." }, { status: 400 });
    const format = req.nextUrl.searchParams.get("format");
    if (format !== "pdf" && format !== "zip") return NextResponse.json({ error: "Formato de exportación inválido." }, { status: 400 });
    try {
        const project = await workflowStore().read<SocialProject>(`social:${id}`);
        if (!project || project.format !== "carousel" || !project.slides) return NextResponse.json({ error: "No se encontró el carrusel." }, { status: 404 });
        const images = await finishedCarouselImages(project);
        const { width, height } = carouselDimensions(project.aspectRatio ?? "");
        const bytes = format === "pdf" ? imagesPdf(images, width, height) : imagesZip(images);
        const filename = project.name.normalize("NFKD").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "carrusel";
        return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": format === "pdf" ? "application/pdf" : "application/zip", "Content-Disposition": `attachment; filename="${filename}.${format}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo exportar el carrusel." }, { status: 409 }); }
}
