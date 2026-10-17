const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function createRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableCode(status, code) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409)
    return /version|changed|stale|immutable/i.test(String(code))
      ? "stale_version"
      : "conflict";
  if (status === 422 || status === 413) return "validation_error";
  if (status === 429) return "rate_limited";
  if (status === 503) return "dependency_unavailable";
  if (status >= 500) return "server_error";
  return code || "server_error";
}

function errorDetails(code, details) {
  if (details !== null && details !== undefined) return details;
  return code ? { legacy_code: code } : null;
}

export function errorResponse(
  status,
  code,
  message,
  requestId = createRequestId(),
  details,
) {
  const stable = stableCode(status, code);
  const headers = new Headers(baseHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-ID", requestId);
  return new Response(
    JSON.stringify({
      error: {
        code: stable,
        message,
        details: errorDetails(code === stable ? null : code, details),
      },
      request_id: requestId,
    }),
    { status, headers },
  );
}

function responseWithHeaders(response, headers, body) {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function finalizeApiResponse(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  if (!JSON_TYPE.test(headers.get("Content-Type") || ""))
    return responseWithHeaders(response, headers, response.body);

  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return responseWithHeaders(response, headers, text);
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "data") &&
    Object.hasOwn(value, "request_id")
  ) {
    const envelope = { ...value, request_id: requestId };
    headers.set("Content-Type", "application/json; charset=utf-8");
    return responseWithHeaders(response, headers, JSON.stringify(envelope));
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return responseWithHeaders(
    response,
    headers,
    JSON.stringify({ data: value, request_id: requestId }),
  );
}
