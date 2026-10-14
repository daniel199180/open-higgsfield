import { getConnectionForProvider } from "@/lib/connection-store";
import { detectGeneratedMediaType } from "@/lib/media-download";
import { isOpenAIEditModel } from "@/lib/openai-edit-models";
import { providerFetch } from "./secure-fetch";
import sharp from "sharp";
import type { GenerationProvider, ProviderGenerationRequest, ProviderPollResult, ProviderSubmission } from "./types";

function pngFromDataUrl(value: string | undefined): Buffer {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value ?? "");
    if (!match || match[1].length > 28 * 1024 * 1024) throw new Error("ERR_OPENAI_INVALID_INPUT");
    const data = Buffer.from(match[1], "base64");
    if (!data.length || data.length > 20 * 1024 * 1024 || detectGeneratedMediaType(data) !== "image/png") throw new Error("ERR_OPENAI_INVALID_INPUT");
    return data;
}

function reportedTokens(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class OpenAIProvider implements GenerationProvider {
    readonly id = "openai" as const;

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        if (request.mediaType !== "image" || !isOpenAIEditModel(request.providerModelId)) throw new Error("ERR_OPENAI_MODEL_UNSUPPORTED");
        const connection = await getConnectionForProvider(this.id, request.connectionId);
        if (!connection?.credentials.apiKey) throw new Error("ERR_OPENAI_API_KEY_NOT_CONFIGURED");
        const values = request.params.field_values ?? {};
        const quality = values.quality;
        const size = request.params.size;
        if (!["low", "medium", "high"].includes(String(quality)) || !["auto", "1024x1024", "1536x1024", "1024x1536"].includes(String(size))) throw new Error("ERR_OPENAI_INVALID_OPTIONS");
        const form = new FormData();
        form.set("model", request.providerModelId);
        form.set("prompt", request.params.prompt);
        form.set("quality", String(quality));
        form.set("size", String(size));
        form.set("output_format", "png");
        form.set("n", "1");
        form.append("image[]", new Blob([new Uint8Array(pngFromDataUrl(request.media.images?.source))], { type: "image/png" }), "source.png");
        if (request.media.images?.reference) form.append("image[]", new Blob([new Uint8Array(pngFromDataUrl(request.media.images.reference))], { type: "image/png" }), "reference.png");
        if (request.media.images?.mask) form.set("mask", new Blob([new Uint8Array(pngFromDataUrl(request.media.images.mask))], { type: "image/png" }), "mask.png");

        let response: Response;
        try {
            response = await providerFetch("openai", "/v1/images/edits", {
                method: "POST", headers: { Authorization: `Bearer ${connection.credentials.apiKey}` }, body: form,
            });
        } catch (error) {
            throw new Error(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "ERR_OPENAI_TIMEOUT" : "ERR_OPENAI_NETWORK");
        }
        if (!response.ok) {
            // Do not echo provider error text: it may contain portions of the prompt or request.
            const code = response.status === 401 || response.status === 403 ? "ERR_OPENAI_AUTH"
                : response.status === 402 || response.status === 429 ? "ERR_OPENAI_LIMIT"
                : response.status === 400 ? "ERR_OPENAI_REJECTED_INPUT" : "ERR_OPENAI_UPSTREAM";
            throw new Error(code);
        }
        const payload = await response.json().catch(() => null) as { data?: Array<{ b64_json?: string }>; usage?: Record<string, unknown> } | null;
        const encoded = payload?.data?.[0]?.b64_json;
        if (typeof encoded !== "string" || encoded.length > 36 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("ERR_OPENAI_INVALID_RESPONSE");
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 24 * 1024 * 1024 || detectGeneratedMediaType(bytes) !== "image/png") throw new Error("ERR_OPENAI_INVALID_RESPONSE");
        try {
            const meta = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
            if (meta.format !== "png" || !meta.width || !meta.height) throw new Error("invalid output");
        } catch { throw new Error("ERR_OPENAI_INVALID_RESPONSE"); }
        const usage = payload?.usage;
        return { status: "COMPLETED", assets: [{ data: bytes, mimeType: "image/png" }], usage: {
            inputTokens: reportedTokens(usage?.input_tokens), outputTokens: reportedTokens(usage?.output_tokens), totalTokens: reportedTokens(usage?.total_tokens),
        } };
    }

    async poll(): Promise<ProviderPollResult> {
        throw new Error("ERR_OPENAI_POLL_UNSUPPORTED");
    }
}
