import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, readLimitedBody } from "@/lib/api-security";
import { appendChatMessage, getChatSession, touchChatSession, updateChatSessionModel, updateChatSessionSettings } from "@/chat/store";
import { streamTextCompletion } from "@/chat/provider";
import { publicErrorMessage } from "@/lib/public-error";
import { parseTextAttachments } from "@/chat/attachments";
import { getChatSkill } from "@/chat/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const command = z.object({ modelId: z.string().trim().min(1).max(400), content: z.string().trim().min(1).max(30_000), webSearch: z.boolean().default(false), reasoning: z.boolean().default(false), skillId: z.string().trim().max(80).optional() }).strict();
const streamHeaders = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" };

function event(value: unknown): Uint8Array {
    return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { sessionId } = await params;
    if (!z.string().uuid().safeParse(sessionId).success) return NextResponse.json({ error: "Sesión inválida." }, { status: 400 });
    try {
        const contentLength = Number(req.headers.get("content-length") || 0);
        if (contentLength > 6_000_000) return NextResponse.json({ error: "Los archivos adjuntos superan el límite permitido." }, { status: 413 });
        const files: File[] = [];
        const contentType = req.headers.get("content-type") || "";
        let input: z.infer<typeof command>;
        if (contentType.startsWith("multipart/form-data")) {
            const form = await req.formData();
            files.push(...form.getAll("files").filter((value): value is File => typeof File !== "undefined" && value instanceof File));
            input = command.parse({ modelId: String(form.get("modelId") || ""), content: String(form.get("content") || ""), webSearch: String(form.get("webSearch") || "false") === "true", reasoning: String(form.get("reasoning") || "false") === "true", skillId: String(form.get("skillId") || "") || undefined });
        } else input = command.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 36 * 1024)).toString("utf8")));
        const attachments = await parseTextAttachments(files);
        const attachmentContext = attachments.map((file) => `--- ${file.name} ---\n${file.content}`).join("\n\n");
        const storedContent = attachments.length ? `${input.content}\n\n[Adjuntos: ${attachments.map((file) => file.name).join(", ")}]` : input.content;
        const session = await getChatSession(sessionId);
        if (!session) return NextResponse.json({ error: "Sesión no encontrada." }, { status: 404 });
        const userMessage = await appendChatMessage({ sessionId, role: "user", content: storedContent, modelId: input.modelId, attachmentNames: attachments.map((file) => file.name) });
        if (!userMessage) return NextResponse.json({ error: "No se pudo guardar el mensaje." }, { status: 500 });
        if (session.modelId !== input.modelId) await updateChatSessionModel(sessionId, input.modelId);
        await updateChatSessionSettings(sessionId, { webSearch: input.webSearch, reasoning: input.reasoning, skillId: input.skillId });
        if (session.title === "Nueva conversación") await touchChatSession(sessionId, input.content.replace(/\s+/g, " ").slice(0, 64));
        const history = [...session.messages, userMessage]
            .slice(-80)
            .map((message) => ({ role: message.role, content: message.content }));
        const completion = await streamTextCompletion(input.modelId, history, { webSearch: input.webSearch, reasoning: input.reasoning, skillPrompt: getChatSkill(input.skillId).prompt, attachmentsContext: attachmentContext || undefined });
        const upstream = completion.response;
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistant = "";
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(event({ type: "user", message: userMessage }));
                if (completion.sources.length) controller.enqueue(event({ type: "sources", sources: completion.sources }));
                try {
                    while (!closed) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split(/\r?\n/);
                        buffer = lines.pop() ?? "";
                        for (const line of lines) {
                            if (!line.startsWith("data:")) continue;
                            const payload = line.slice(5).trim();
                            if (!payload || payload === "[DONE]") continue;
                            try {
                                const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
                                const delta = parsed.choices?.[0]?.delta?.content;
                                if (typeof delta === "string" && delta) {
                                    assistant += delta;
                                    controller.enqueue(event({ type: "delta", delta }));
                                }
                            } catch {
                                // Ignore provider keep-alives and incomplete SSE frames.
                            }
                        }
                    }
                    if (assistant) {
                        const message = await appendChatMessage({ sessionId, role: "assistant", content: assistant, modelId: input.modelId, sources: completion.sources });
                        controller.enqueue(event({ type: "done", message }));
                    } else {
                        controller.enqueue(event({ type: "error", error: "ERR_OPENROUTER_INVALID_RESPONSE" }));
                    }
                } catch (error) {
                    controller.enqueue(event({ type: "error", error: publicErrorMessage(error, "ERR_OPENROUTER_NETWORK") }));
                } finally {
                    closed = true;
                    controller.close();
                }
            },
            cancel() { closed = true; void reader.cancel().catch(() => undefined); },
        });
        return new Response(stream, { headers: streamHeaders });
    } catch (error) {
        return NextResponse.json({ error: error instanceof z.ZodError ? "Escribe un mensaje y elige un modelo." : publicErrorMessage(error, "ERR_OPENROUTER_REQUEST_FAILED") }, { status: 400 });
    }
}
