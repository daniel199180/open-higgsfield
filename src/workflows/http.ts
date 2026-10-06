import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { WorkflowError } from "./types";

export function workflowError(error: unknown) {
    const message = error instanceof WorkflowError ? error.message : error instanceof ZodError || error instanceof SyntaxError ? "Revisa los campos del workflow. No se guardó ni ejecutó la solicitud." : "No se pudo completar la operación de workflows.";
    return NextResponse.json({ error: message }, { status: error instanceof WorkflowError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500, headers: { "Cache-Control": "no-store" } });
}
