// Never forward provider messages: they may include prompts, headers or secrets.
// Retain only numeric status and a closed set of locally defined error codes.
export function openRouterFailure(httpStatus: number, payload: unknown) {
    const error = payload && typeof payload === "object" && "error" in payload
        ? (payload as { error: unknown }).error : undefined;
    const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const providerStatus = typeof detail.code === "number" && Number.isInteger(detail.code)
        && detail.code >= 400 && detail.code <= 599 ? detail.code : undefined;
    const status = httpStatus >= 400 ? httpStatus : providerStatus;
    const message = typeof detail.message === "string" ? detail.message : "";
    let code = "ERR_OPENROUTER_REQUEST_FAILED";
    if (status === 401) code = "ERR_OPENROUTER_AUTH";
    else if (status === 402) code = "ERR_OPENROUTER_CREDITS";
    else if (status === 403) code = "ERR_OPENROUTER_FORBIDDEN";
    else if (status === 404) code = "ERR_OPENROUTER_MODEL_UNAVAILABLE";
    else if (status === 408 || status === 504) code = "ERR_OPENROUTER_TIMEOUT";
    else if (status === 429) code = "ERR_OPENROUTER_RATE_LIMIT";
    else if (status === 400 || status === 422) code = "ERR_OPENROUTER_PARAMETERS";
    else if (status && status >= 500) code = "ERR_OPENROUTER_PROVIDER_UNAVAILABLE";
    // Known policy/routing failures can be returned with several status codes.
    if (/no endpoints.*(?:privacy|data policy|data collection|zdr)/i.test(message)) code = "ERR_OPENROUTER_PRIVACY";
    return { code, httpStatus, ...(providerStatus ? { providerStatus } : {}) };
}
