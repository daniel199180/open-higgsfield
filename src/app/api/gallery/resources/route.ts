import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { getImageTasks, getVideoTasks, initStore } from "@/lib/task-store";
import type { AudioResult } from "@/audio/types";
import type { Asset } from "@/workflows/types";
import { workflowStore } from "@/workflows/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type GalleryResourceKind = "image" | "video" | "audio";

export interface GalleryResource {
    id: string;
    kind: GalleryResourceKind;
    url: string;
    title: string;
    createdAt: number;
    source: "generation" | "asset";
    taskId?: string;
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        await initStore();
        const resources: GalleryResource[] = [];
        const kind = req.nextUrl.searchParams.get("kind");

        if (!kind || kind === "image") {
            for (const task of getImageTasks()) {
                if (task.status !== "COMPLETED" || task.reuse_state?.editor_internal) continue;
                for (const [index] of (task.result_urls ?? []).entries()) resources.push({
                    id: `task:${task.task_id}:${index}`, kind: "image",
                    url: `/api/download/${encodeURIComponent(task.task_id)}?index=${index}`,
                    title: task.prompt || "Imagen generada", createdAt: Date.parse(task.created_at) || 0,
                    source: "generation", taskId: task.task_id,
                });
            }
        }

        if (!kind || kind === "video") {
            for (const task of getVideoTasks()) {
                if (task.status !== "COMPLETED") continue;
                const url = task.video_path ? `/api/download/${encodeURIComponent(task.task_id)}?inline=1` : task.video_urls?.[0];
                if (!url) continue;
                resources.push({
                    id: `task:${task.task_id}:video`, kind: "video", url,
                    title: task.prompt || "Video generado", createdAt: Date.parse(task.created_at) || 0,
                    source: "generation", taskId: task.task_id,
                });
            }
        }

        const [assets, audios] = await Promise.all([
            workflowStore().list<Asset>("asset:"), workflowStore().list<AudioResult>("audio:"),
        ]);
        const audioTitles = new Map(audios.map(audio => [audio.assetId, audio.voiceName || "Audio generado"]));
        for (const asset of assets) {
            if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") continue;
            if (kind && kind !== asset.kind) continue;
            resources.push({
                id: `asset:${asset.id}`, kind: asset.kind, url: `/api/workflows/assets/${asset.id}`,
                title: asset.kind === "audio" ? (audioTitles.get(asset.id) || "Audio generado") : asset.kind === "video" ? "Video guardado" : "Imagen guardada",
                createdAt: asset.createdAt, source: "asset",
            });
        }
        resources.sort((left, right) => right.createdAt - left.createdAt);
        return NextResponse.json({ resources }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ error: "No se pudo cargar la galería de recursos." }, { status: 500 });
    }
}
