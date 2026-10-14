import { uploadToTmpfiles } from "@/lib/upload";
import type { ProviderId } from "@/providers/types";

/** Return a provider-compatible reference without making local images public when possible. */
export async function imageReferenceForProvider(provider: ProviderId | undefined, jpeg: Buffer): Promise<string> {
    if (provider === "openrouter" || provider === "google-ai-studio" || provider === "google-vertex") {
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }
    return uploadToTmpfiles(jpeg, "file.jpg", "image/jpeg");
}
