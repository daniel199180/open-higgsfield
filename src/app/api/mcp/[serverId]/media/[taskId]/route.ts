import fs from "node:fs/promises";
import mime from "mime-types";
import { NextRequest, NextResponse } from "next/server";
import { getMcpServer } from "@/lib/mcp-server-store";
import { getTask, initStore } from "@/lib/task-store";
import { safeDownloadName, taskBelongsToServer, taskMediaPaths, verifyMediaSignature } from "@/lib/mcp-runtime";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ serverId: string; taskId: string }> }) {
    const { serverId, taskId } = await params;
    const server = await getMcpServer(serverId);
    const index = Number(req.nextUrl.searchParams.get("index"));
    const expires = Number(req.nextUrl.searchParams.get("expires"));
    const signature = req.nextUrl.searchParams.get("signature") ?? "";
    if (!server?.enabled || !verifyMediaSignature(server, taskId, index, expires, signature)) {
        return NextResponse.json({ error: "Enlace no válido o caducado." }, { status: 401 });
    }
    await initStore();
    const task = getTask(taskId);
    if (!task || !taskBelongsToServer(task, serverId)) return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
    const file = taskMediaPaths(task)[index];
    if (!file) return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
    try {
        const data = await fs.readFile(file);
        return new NextResponse(data, { headers: {
            "Content-Type": String(mime.lookup(file) || "application/octet-stream"),
            "Content-Disposition": `inline; filename="${safeDownloadName(task, file)}"`,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        } });
    } catch { return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 }); }
}
