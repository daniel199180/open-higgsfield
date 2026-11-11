import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import type { NextRequest } from "next/server";
import type { McpServerConfig } from "@/lib/mcp-server-store";
import type { AnyTask } from "@/types";

export function bearerToken(req: NextRequest): string {
    const approvedApiManagementToken = req.headers.get("ocp-apim-subscription-key")?.trim() ?? "";
    if (approvedApiManagementToken) return approvedApiManagementToken;
    const dedicatedToken = req.headers.get("x-mcp-token")?.trim() ?? "";
    if (dedicatedToken) return dedicatedToken;
    const authorization = req.headers.get("authorization") ?? "";
    return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export function taskBelongsToServer(task: AnyTask, serverId: string): boolean {
    return task.reuse_state?.mcpServerId === serverId;
}

function mediaSignature(server: McpServerConfig, taskId: string, index: number, expires: number): string {
    return crypto.createHmac("sha256", server.tokenHash).update(`${taskId}:${index}:${expires}`).digest("base64url");
}

export function signedMediaUrl(req: NextRequest, server: McpServerConfig, taskId: string, index: number): string {
    const expires = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = mediaSignature(server, taskId, index, expires);
    const publicOrigin = process.env.OPEN_HIGGSFIELD_APP_ORIGIN || req.nextUrl.origin;
    return new URL(`/api/mcp/${server.id}/media/${taskId}?index=${index}&expires=${expires}&signature=${signature}`, publicOrigin).href;
}

export function verifyMediaSignature(server: McpServerConfig, taskId: string, index: number, expires: number, signature: string): boolean {
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(mediaSignature(server, taskId, index, expires));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function taskMediaPaths(task: AnyTask): string[] {
    if (task.media_type === "image") return task.result_paths ?? [];
    return task.video_path ? [task.video_path] : [];
}

export function safeDownloadName(task: AnyTask, file: string): string {
    const extension = path.extname(file).replace(/[^a-zA-Z0-9.]/g, "") || (task.media_type === "image" ? ".png" : ".mp4");
    return `${task.media_type}-${task.task_id}${extension}`;
}
