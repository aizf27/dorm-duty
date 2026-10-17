import { request, ApiError } from "./client";

export { ApiError, request } from "./client";
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return request<T>(path, options, {
    token: sessionStorage.getItem("dorm-token") || "",
    fallbackMessage: "请求失败，请稍后重试",
  });
}
export function post<T>(path: string, data: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(data) });
}
export function patch<T>(path: string, data: unknown = {}) {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}
export function query(params: Record<string, string | number | undefined>) {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}
