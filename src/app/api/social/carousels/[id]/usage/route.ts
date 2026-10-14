import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest } from "@/lib/api-security";
import { billingStore } from "@/billing/store";
import { workflowStore } from "@/workflows/store";
import type { SocialProject } from "@/social/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("carousel-usage", 60); if (limited) return limited;
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Carrusel inválido." }, { status: 400 });
    try {
        const project = await workflowStore().read<SocialProject>(`social:${id}`);
        if (!project?.slides || project.format !== "carousel") return NextResponse.json({ error: "No se encontró el carrusel." }, { status: 404 });
        const ids = [...new Set(project.slides.flatMap(slide => slide.taskIds.map(taskId => `studio:${taskId}`)))];
        return NextResponse.json({ records: await billingStore().records(ids) }, { headers: { "Cache-Control": "no-store" } });
    } catch { return NextResponse.json({ error: "No se pudo consultar el consumo de este carrusel." }, { status: 500 }); }
}
