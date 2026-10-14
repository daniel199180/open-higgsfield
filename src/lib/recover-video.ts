import "server-only";
import { billingStore } from "@/billing/store";
import { attachGeneratedAssets } from "@/lib/generated-assets";
import { getTask, initStore, pushEvent, saveTasks } from "@/lib/task-store";
import { getProvider } from "@/providers/registry";
import type { VideoTask } from "@/types";

export class VideoRecoveryError extends Error {
    constructor(message: string, readonly status = 409) { super(message); }
}

/** Only re-polls an already submitted job and retrieves its media. Never generates. */
export async function recoverOpenRouterVideoTask(taskId: string) {
    await initStore();
    const task = getTask(taskId) as VideoTask | undefined;
    if (!task || task.media_type !== "video") throw new VideoRecoveryError("Video no encontrado.", 404);
    if (task.status === "COMPLETED" && task.video_path) return `/api/download/${taskId}`;
    if (task.provider_id !== "openrouter" || !task.provider_operation || !["ERROR", "FAILED"].includes(task.status ?? "")) {
        throw new VideoRecoveryError("Esta tarea no admite recuperación sin generar de nuevo.");
    }
    const result = await getProvider("openrouter").poll({
        mediaType: "video", providerModelId: task.provider_model_id ?? task.model_id, operation: task.provider_operation,
    });
    if (result.status !== "COMPLETED" || !result.assets.length) {
        throw new VideoRecoveryError(result.status === "FAILED" ? "OpenRouter indica que este video falló; no hay archivo que recuperar." : "El video todavía no está disponible en OpenRouter.");
    }
    await attachGeneratedAssets(task, result.assets);
    task.provider_operation = result.operation ?? task.provider_operation;
    task.status = "COMPLETED";
    task.freepik_status = "COMPLETED";
    task.error_message = undefined;
    await billingStore().update(`studio:${taskId}`, "COMPLETED", result.usage);
    pushEvent(taskId, { type: "completed", video_urls: task.video_urls ?? [], has_download: !!task.video_path });
    await saveTasks();
    return `/api/download/${taskId}`;
}
