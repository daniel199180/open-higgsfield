const MAX_TEXT_FILE_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 4_000_000;
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|log)$/i;

export interface ParsedAttachment {
    name: string;
    content: string;
}

export async function parseTextAttachments(files: File[]): Promise<ParsedAttachment[]> {
    let total = 0;
    const result: ParsedAttachment[] = [];
    for (const file of files.slice(0, 8)) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 160) || "archivo";
        if (!TEXT_TYPES.has(file.type) && !TEXT_EXTENSIONS.test(safeName)) {
            throw new Error("ERR_CHAT_ATTACHMENT_UNSUPPORTED");
        }
        if (file.size > MAX_TEXT_FILE_BYTES || (total + file.size) > MAX_TOTAL_BYTES) throw new Error("ERR_CHAT_ATTACHMENT_TOO_LARGE");
        total += file.size;
        const content = (await file.text()).replace(/\u0000/g, "").trim();
        if (content) result.push({ name: safeName, content: content.slice(0, MAX_TEXT_FILE_BYTES) });
    }
    return result;
}
