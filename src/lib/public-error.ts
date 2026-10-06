export function publicErrorMessage(error: unknown, fallback = "ERR_GENERATION_FAILED"): string {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    // Provider messages may echo request headers or credentials. Only expose our code.
    return message.match(/^(ERR_[A-Z0-9_]+)(?::|$)/)?.[1] ?? fallback;
}
