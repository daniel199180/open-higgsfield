import { z } from "zod";
import { providerBase } from "@/providers/secure-fetch";
export const connectionSchema = z.object({
    id: z.string().uuid().optional(),
    provider: z.enum(["openrouter", "higgsfield", "api-market"]),
    name: z.string().trim().min(1).max(80),
    config: z.object({
        baseUrl: z.string().max(200).optional(),
        workspace: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
        slug: z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/).optional(),
        mediaType: z.enum(["image", "video", "both"]).optional(),
        toolName: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/).optional(),
        statusToolName: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/).optional(),
    }).strict().default({}),
    credentials: z.object({ apiKey: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional() }).strict().default({}),
    enabled: z.boolean().optional(), isDefault: z.boolean().optional(), test: z.boolean().optional(),
}).strict();
export function validateConnectionConfig(value: z.infer<typeof connectionSchema>) {
    providerBase(value.provider, value.config.baseUrl);
    if (value.provider === "api-market" && (!value.config.workspace || !value.config.slug)) throw new Error("ERR_API_MARKET_PRODUCT_NOT_CONFIGURED");
}
