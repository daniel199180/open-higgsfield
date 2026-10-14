import "server-only";
import type { CompanyFolder } from "./types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";

export async function requireCompany(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WorkflowError("La carpeta de empresa no es válida.", 400);
    const folder = await workflowStore().read<CompanyFolder>(`company:${id}`);
    if (!folder) throw new WorkflowError("La carpeta de empresa ya no existe.", 404);
    return folder.id;
}
