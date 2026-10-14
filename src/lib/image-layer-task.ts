import type { ImageTask } from "@/types";

/** Internal layer documents are editor data, not publishable library assets. */
export function isLayerTask(task: Pick<ImageTask, "internal_kind" | "reuse_state"> | null | undefined): boolean {
    if (!task) return false;
    return task.internal_kind === "layer"
        || !!task.reuse_state?.layer_set
        || task.reuse_state?.edit_mode === "layer-decomposition"
        || task.reuse_state?.edit_mode === "layer-edit";
}
