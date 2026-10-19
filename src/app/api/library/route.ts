import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { getImageTasks, getTask, getVideoTasks, initStore, saveTasks } from "@/lib/task-store";
import { requireCompany } from "@/library/server";
import type { CompanyFolder, CompanyLibraryItem, CompanyLibraryPage, LibraryKind } from "@/library/types";
import type { SocialProject, LogoResult } from "@/social/types";
import type { AudioResult } from "@/audio/types";
import type { WorkflowRun, Asset, NodeRun } from "@/workflows/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { isLayerTask } from "@/lib/image-layer-task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignment = z.object({ kind: z.enum(["image", "video", "carousel", "logo", "audio", "workflow"]), id: z.string().min(1).max(100), companyId: z.uuid().nullable() }).strict();
const PAGE_SIZE = 15 as const;

function queryText(value: string | null): string {
    return (value ?? "").trim().slice(0, 160).toLocaleLowerCase("es");
}

function hasMedia(task: { result_paths?: string[]; result_urls?: string[] }): boolean {
    return Boolean(task.result_paths?.length || task.result_urls?.length);
}

function buildLibraryItems(
    images: ReturnType<typeof getImageTasks>,
    videos: ReturnType<typeof getVideoTasks>,
    carousels: SocialProject[],
    logos: LogoResult[],
    audios: AudioResult[],
    runs: WorkflowRun[],
    assets: Asset[],
): CompanyLibraryItem[] {
    const all: CompanyLibraryItem[] = [];
    const carouselTasks = new Set(carousels.flatMap(project => project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds));
    const imageById = new Map(images.map(task => [task.task_id, task]));

    for (const task of images) {
        if (isLayerTask(task) || task.reuse_state?.editor_internal || carouselTasks.has(task.task_id)) continue;
        const count = Math.max(task.result_paths?.length ?? 0, task.result_urls?.length ?? 0);
        for (let index = 0; index < Math.max(1, count); index++) all.push({
            kind: "image", id: task.task_id, companyId: task.company_id,
            title: task.prompt || "Imagen sin descripción", detail: task.model_id,
            date: Date.parse(task.created_at) || 0, status: task.status,
            preview: count ? `/api/download/${encodeURIComponent(task.task_id)}?index=${index}` : undefined,
            href: count ? `/api/download/${encodeURIComponent(task.task_id)}?index=${index}` : undefined,
        });
    }

    for (const task of videos) all.push({
        kind: "video", id: task.task_id, companyId: task.company_id,
        title: task.prompt || "Video sin descripción", detail: task.model_id,
        date: Date.parse(task.created_at) || 0, status: task.status,
        preview: task.video_path ? `/api/download/${encodeURIComponent(task.task_id)}?inline=1` : task.video_urls?.[0],
        href: task.video_path ? `/api/download/${encodeURIComponent(task.task_id)}` : task.video_urls?.[0],
    });

    for (const project of carousels) if (project.format === "carousel") {
        const taskId = (project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds).find(id => hasMedia(imageById.get(id) ?? {}));
        all.push({
            kind: "carousel", id: project.id, companyId: project.companyId,
            title: project.name, detail: project.brief,
            searchText: project.slides?.map(slide => `${slide.title} ${slide.body} ${slide.visualPrompt}`).join(" "),
            date: project.createdAt, status: project.status,
            preview: taskId ? `/api/download/${encodeURIComponent(taskId)}?index=0` : undefined,
            href: `/api/social/carousels/${encodeURIComponent(project.id)}/export?format=zip`,
            carouselId: project.id,
        });
    }

    for (const logo of logos) all.push({
        kind: "logo", id: logo.id, companyId: logo.companyId, title: logo.prompt,
        detail: logo.mode === "trace" ? "Vectorización" : logo.modelId || "Logo vectorial",
        date: logo.createdAt, preview: `/api/workflows/assets/${logo.previewAssetId}`,
        href: `/api/workflows/assets/${logo.vectorAssetId}?download=1`,
    });
    for (const audio of audios) all.push({
        kind: "audio", id: audio.id, companyId: audio.companyId, title: audio.voiceName,
        detail: audio.text, date: Date.parse(audio.createdAt) || 0,
        audio: `/api/workflows/assets/${audio.assetId}`,
        href: `/api/workflows/assets/${audio.assetId}?download=1`,
    });

    const assetById = new Map(assets.map(asset => [asset.id, asset]));
    for (const run of runs) {
        const assetId = [...new Set(Object.values(run.nodes).flatMap(outputAssets))]
            .find(id => ["image", "video"].includes(assetById.get(id)?.kind ?? ""));
        const asset = assetId ? assetById.get(assetId) : undefined;
        all.push({
            kind: "workflow", id: run.id, companyId: run.companyId, title: run.name,
            detail: "Ejecución de workflow", date: run.createdAt, status: run.status,
            preview: assetId ? `/api/workflows/assets/${assetId}` : undefined,
            href: assetId ? `/api/workflows/assets/${assetId}?download=1` : undefined,
            videoPreview: asset?.kind === "video", workflowId: run.workflowId, runId: run.id,
        });
    }

    return all.sort((a, b) => b.date - a.date);
}

function paginateLibrary(items: CompanyLibraryItem[], params: { page: number; folder: string; kind: LibraryKind | "all"; query: string }) {
    const folderFiltered = items.filter(item => params.folder === "all"
        || (params.folder === "unassigned" ? !item.companyId : item.companyId === params.folder));
    const filtered = folderFiltered.filter(item => (params.kind === "all" || item.kind === params.kind)
        && (!params.query || `${item.title} ${item.detail} ${item.searchText ?? ""} ${item.id}`.toLocaleLowerCase("es").includes(params.query)));
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(params.page, totalPages);
    return {
        items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        page: { page, pageSize: PAGE_SIZE, total: filtered.length, totalPages } satisfies CompanyLibraryPage,
        counts: items.reduce<Record<string, number>>((result, item) => {
            const key = item.companyId || "unassigned";
            result[key] = (result[key] ?? 0) + 1;
            result.all = (result.all ?? 0) + 1;
            return result;
        }, { all: 0, unassigned: 0 }),
    };
}

function outputAssets(node: NodeRun): string[] {
    return [...(node.value?.assetIds ?? []), ...Object.values(node.angles ?? {}).flatMap(outputAssets), ...Object.values(node.formats ?? {}).flatMap(outputAssets)];
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        await initStore();
        const store = workflowStore();
        const url = new URL(req.url);
        const requestedPage = Number(url.searchParams.get("page") ?? "1");
        const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
        const folder = url.searchParams.get("folder") ?? "all";
        const kindValue = url.searchParams.get("kind") ?? "all";
        const kind: LibraryKind | "all" = ["all", "image", "video", "carousel", "logo", "audio", "workflow"].includes(kindValue)
            ? kindValue as LibraryKind | "all" : "all";
        const query = queryText(url.searchParams.get("query"));
        const [companies, carousels, logos, audios, runs, assets] = await Promise.all([
            store.list<CompanyFolder>("company:"), store.list<SocialProject>("social:"),
            store.list<LogoResult>("logo:"), store.list<AudioResult>("audio:"), store.list<WorkflowRun>("run:"), store.list<Asset>("asset:"),
        ]);
        const paginated = paginateLibrary(buildLibraryItems(getImageTasks(), getVideoTasks(), carousels, logos, audios, runs, assets), { page, folder, kind, query });
        return NextResponse.json({ companies, items: paginated.items, page: paginated.page, counts: paginated.counts }, { headers: { "Cache-Control": "private, no-store" } });
    } catch { return NextResponse.json({ error: "No se pudo cargar la biblioteca." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("library-assignment", 120); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = assignment.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 4096)).toString("utf8")));
        const companyId = await requireCompany(input.companyId ?? undefined);
        if (input.kind === "image" || input.kind === "video") {
            await initStore();
            const task = getTask(input.id);
            if (!task || task.media_type !== input.kind) throw new WorkflowError("No se encontró la generación.", 404);
            task.company_id = companyId;
            await saveTasks();
        } else {
            const prefix: Record<Exclude<LibraryKind, "image" | "video">, string> = { carousel: "social", logo: "logo", audio: "audio", workflow: "run" };
            const key = `${prefix[input.kind]}:${input.id}`;
            const updated = await workflowStore().transaction(docs => {
                const previous = docs.get(key) as SocialProject | LogoResult | AudioResult | WorkflowRun | undefined;
                if (!previous || input.kind === "carousel" && !("format" in previous && previous.format === "carousel")) throw new WorkflowError("No se encontró la generación.", 404);
                const next = { ...previous, companyId };
                docs.set(key, next);
                return next;
            });
            if (input.kind === "carousel") {
                await initStore();
                const project = updated as SocialProject;
                for (const id of project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds) {
                    const task = getTask(id);
                    if (task?.media_type === "image") task.company_id = companyId;
                }
                await saveTasks();
            }
        }
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Revisa la generación y la empresa." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo mover la generación." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
