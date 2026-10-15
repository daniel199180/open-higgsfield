import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { getImageTasks, initStore } from "@/lib/task-store";
import { workflowStore } from "@/workflows/store";
import type { Asset } from "@/workflows/types";
import { saveAsset } from "@/workflows/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface GalleryImage {
    id: string;
    url: string;
    title: string;
    createdAt: number;
    source: "generation" | "upload" | "asset";
    taskId?: string;
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        await initStore();
        const images: GalleryImage[] = [];
        for (const task of getImageTasks()) {
            if (task.status !== "COMPLETED" || task.reuse_state?.editor_internal) continue;
            const urls = task.result_urls ?? [];
            urls.forEach((url, index) => images.push({
                id: `task:${task.task_id}:${index}`,
                url: `/api/download/${encodeURIComponent(task.task_id)}?index=${index}`,
                title: task.prompt || "Imagen generada",
                createdAt: Date.parse(task.created_at) || 0,
                source: "generation",
                taskId: task.task_id,
            }));
        }
        const assets = await workflowStore().list<Asset>("asset:");
        for (const asset of assets) {
            if (asset.kind !== "image") continue;
            images.push({ id: `asset:${asset.id}`, url: `/api/workflows/assets/${asset.id}`, title: "Imagen guardada", createdAt: asset.createdAt, source: "asset" });
        }
        images.sort((a, b) => b.createdAt - a.createdAt);
        return NextResponse.json({ images }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ error: "No se pudo cargar la galería de imágenes." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("gallery-upload", 20); if (limited) return limited;
    try {
        const mime = req.headers.get("content-type") ?? "";
        if (!/^image\/(png|jpeg|webp|avif)$/.test(mime)) return NextResponse.json({ error: "Sube una imagen PNG, JPEG, WebP o AVIF." }, { status: 400 });
        const asset = await saveAsset(Buffer.from(await readLimitedBody(req, 20 * 1024 * 1024)), "image", mime);
        return NextResponse.json({ image: { id: `asset:${asset.id}`, url: `/api/workflows/assets/${asset.id}`, title: "Imagen guardada", createdAt: asset.createdAt, source: "upload" as const } }, { status: 201 });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo guardar la imagen." }, { status: 400 });
    }
}
