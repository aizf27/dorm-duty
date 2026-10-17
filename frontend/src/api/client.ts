import { networkState } from "./network";
import { appPath } from "./path";

type ErrorDetails = unknown;

export interface RequestConfig {
  token?: string;
  fallbackMessage?: string;
  signal?: AbortSignal;
  clearSessionOn401?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "request_failed",
    public details: ErrorDetails = null,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function stableCode(status: number) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422 || status === 413) return "validation_error";
  if (status === 429) return "rate_limited";
  if (status === 503) return "dependency_unavailable";
  if (status >= 500) return "server_error";
  return "request_failed";
}

function clearExpiredSession() {
  sessionStorage.removeItem("dorm-token");
  try {
    localStorage.removeItem("dorm-email-admin-grant");
  } catch {
    // Optional persistence.
  }
  window.dispatchEvent(new Event("auth-expired"));
}

function isJsonResponse(response: Response) {
  return /^application\/json(?:\s*;|$)/i.test(
    response.headers.get("Content-Type") || "",
  );
}

function parseError(
  status: number,
  data: unknown,
  requestId: string | null,
  fallbackMessage: string,
) {
  const body =
    data && typeof data === "object" ? (data as Record<string, any>) : {};
  const error =
    body.error && typeof body.error === "object" ? body.error : {};
  const legacy =
    body.detail && typeof body.detail === "object" ? body.detail : {};
  const legacyCode = typeof legacy.code === "string" ? legacy.code : null;
  const code =
    typeof error.code === "string"
      ? error.code
      : legacyCode || stableCode(status);
  const details =
    error.details ?? (legacyCode ? { legacy_code: legacyCode } : null);
  const message =
    typeof error.message === "string"
      ? error.message
      : typeof legacy.message === "string"
        ? legacy.message
        : fallbackMessage;
  return new ApiError(status, message, code, details, requestId);
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
  config: RequestConfig = {},
): Promise<T> {
  const controller = new AbortController();
  let externalAbort = false;
  const onAbort = () => {
    externalAbort = true;
    controller.abort();
  };
  config.signal?.addEventListener("abort", onAbort, { once: true });
  if (config.signal?.aborted) onAbort();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (config.token && !headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${config.token}`);
  try {
    const response = await fetch(appPath(path), {
      ...options,
      signal: controller.signal,
      credentials: options.credentials || "same-origin",
      cache: options.cache || "no-store",
      headers,
    });
    networkState.unreachable = false;
    const requestId = response.headers.get("X-Request-ID");
    const data = isJsonResponse(response)
      ? await response.json().catch(() => null)
      : null;
    if (!response.ok) {
      if (
        response.status === 401 &&
        config.clearSessionOn401 !== false &&
        (Boolean(config.token) || path.startsWith("/auth/")) &&
        path !== "/auth/login"
      )
        clearExpiredSession();
      throw parseError(
        response.status,
        data,
        requestId || (data as any)?.request_id || null,
        config.fallbackMessage || "请求失败，请稍后重试",
      );
    }
    if (data && typeof data === "object" && Object.hasOwn(data, "data"))
      return (data as { data: T }).data;
    return data as T;
  } catch (error) {
    if (externalAbort) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof ApiError) throw error;
    networkState.unreachable = true;
    throw new Error(
      navigator.onLine ? "连接服务失败，请稍后重试" : "当前离线，请联网后重试",
    );
  } finally {
    clearTimeout(timeout);
    config.signal?.removeEventListener("abort", onAbort);
  }
}
