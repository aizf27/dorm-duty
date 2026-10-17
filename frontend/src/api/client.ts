import { networkState } from "./network";
import { appPath } from "./path";
import { normalizeApiError, unwrapApiData } from "./protocol";

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
  const error = normalizeApiError(status, data, requestId, fallbackMessage);
  return new ApiError(
    status,
    error.message,
    error.code,
    error.details,
    error.requestId,
  );
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
    return unwrapApiData<T>(data);
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
