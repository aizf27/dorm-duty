export interface NormalizedApiError {
  code: string;
  details: unknown;
  message: string;
  requestId: string | null;
}

function stableCode(status: number) {
  if (status === 400 || status === 413 || status === 422)
    return "validation_error";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 503) return "dependency_unavailable";
  if (status >= 500) return "server_error";
  return "request_failed";
}

export function normalizeApiError(
  status: number,
  data: unknown,
  headerRequestId: string | null,
  fallbackMessage: string,
): NormalizedApiError {
  const body =
    data && typeof data === "object" ? (data as Record<string, any>) : {};
  const error =
    body.error && typeof body.error === "object" ? body.error : {};
  const legacy =
    body.detail && typeof body.detail === "object" ? body.detail : {};
  const legacyCode = typeof legacy.code === "string" ? legacy.code : null;
  return {
    code:
      typeof error.code === "string"
        ? error.code
        : legacyCode || stableCode(status),
    details:
      error.details ?? (legacyCode ? { legacy_code: legacyCode } : null),
    message:
      typeof error.message === "string"
        ? error.message
        : typeof legacy.message === "string"
          ? legacy.message
          : fallbackMessage,
    requestId:
      headerRequestId ||
      (typeof body.request_id === "string" ? body.request_id : null),
  };
}

export function unwrapApiData<T>(data: unknown): T {
  if (data && typeof data === "object" && Object.hasOwn(data, "data"))
    return (data as { data: T }).data;
  return data as T;
}
