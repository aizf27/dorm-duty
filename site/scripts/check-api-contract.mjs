import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../../frontend/node_modules/typescript/lib/typescript.js";
import {
  createRequestId,
  errorResponse,
  finalizeApiResponse,
} from "../worker/shared/api.mjs";
import {
  EMAIL_GATE_CAPABILITY,
  handleApi,
} from "../worker/backend.mjs";
import { createHarness } from "./check-cloud-backend.mjs";

let assertions = 0;
const check = (value, message) => {
  assertions++;
  assert.ok(value, message);
};
const json = async (response) => response.json();
const bodyData = (body) => body?.data ?? body;

const protocolSource = await readFile(
  new URL("../../frontend/src/api/protocol.ts", import.meta.url),
  "utf8",
);
const protocolJavaScript = ts.transpileModule(protocolSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { normalizeApiError, unwrapApiData } = await import(
  `data:text/javascript;base64,${Buffer.from(protocolJavaScript).toString("base64")}`
);

check(unwrapApiData({ data: { ok: true } }).ok, "frontend unwraps new success envelope");
check(unwrapApiData({ ok: true }).ok, "frontend keeps legacy success response");
const newError = normalizeApiError(
  409,
  {
    error: {
      code: "stale_version",
      message: "changed",
      details: { version: 2 },
    },
    request_id: "body-request",
  },
  "header-request",
  "fallback",
);
check(newError.code === "stale_version", "frontend reads stable error code");
check(newError.details.version === 2, "frontend reads error details");
check(newError.requestId === "header-request", "frontend prefers request id header");
const legacyError = normalizeApiError(
  403,
  { detail: { code: "not_admin", message: "legacy" } },
  null,
  "fallback",
);
check(legacyError.code === "not_admin", "frontend reads legacy error code");
check(legacyError.message === "legacy", "frontend reads legacy error message");
check(
  legacyError.details.legacy_code === "not_admin",
  "frontend preserves legacy error code in details",
);

for (const [status, code] of [
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [422, "validation_error"],
  [429, "rate_limited"],
  [503, "dependency_unavailable"],
  [500, "server_error"],
]) {
  const requestId = createRequestId();
  const response = errorResponse(status, "legacy_fixture", "fixture", requestId);
  const body = await json(response);
  check(body.error.code === code, `${status} maps to ${code}`);
  check(body.request_id === requestId, `${status} body request_id`);
  check(response.headers.get("X-Request-ID") === requestId, `${status} header request_id`);
  check(body.error.details.legacy_code === "legacy_fixture", `${status} preserves legacy code`);
}

const direct = await finalizeApiResponse(
  new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  }),
  "request-direct",
);
const directBody = await json(direct);
check(directBody.data.ok === true, "direct success is wrapped");
check(directBody.request_id === "request-direct", "wrapped success request_id");
check(direct.headers.get("X-Request-ID") === "request-direct", "wrapped success header request_id");

const oldSuccess = await finalizeApiResponse(
  new Response(JSON.stringify({ data: { ok: true }, request_id: "old" }), {
    headers: { "Content-Type": "application/json" },
  }),
  "request-new",
);
check((await json(oldSuccess)).data.ok === true, "already wrapped success stays readable");

const oldError = {
  detail: { code: "invite_required", message: "fixture" },
};
check(
  bodyData(oldError).detail.code === "invite_required",
  "legacy error shape remains representable during migration",
);

const harness = await createHarness();
try {
  const health = await harness.request("/health");
  const healthBody = await json(health);
  check(health.status === 200, "health succeeds");
  check(healthBody.data.runtime === "cloudflare-worker", "health is enveloped");
  check(
    healthBody.request_id === health.headers.get("X-Request-ID"),
    "health body/header request_id match",
  );

  const room = await harness.request("/guest/create", {
    method: "POST",
    data: { name: "契约验收", nickname: "验收者" },
  });
  const roomBody = await json(room);
  const roomData = roomBody.data;
  const subscription = await harness.request("/chores/calendar-subscription", {
    method: "POST",
    token: roomData.access_token,
    data: { version: 0, include_alarms: false },
  });
  const subscriptionData = bodyData(await json(subscription));
  const feed = await harness.request(subscriptionData.path);
  check(feed.status === 200, "calendar feed succeeds");
  check(
    /^text\/calendar/i.test(feed.headers.get("Content-Type") || ""),
    "calendar feed remains non-JSON",
  );
  check(!(await feed.text()).trimStart().startsWith("{"), "calendar feed is not enveloped");

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const unexpected = await handleApi(
      new Request("https://contract.example/health"),
      {
        DB: {
          prepare() {
            throw new Error("secret fixture value");
          },
          batch() {},
        },
        EMAIL_GATE_VERIFIED: EMAIL_GATE_CAPABILITY,
      },
      { waitUntil() {} },
    );
    const unexpectedBody = await json(unexpected);
    const requestId = unexpected.headers.get("X-Request-ID");
    check(unexpected.status === 500, "unexpected exception maps to 500");
    check(unexpectedBody.error.code === "server_error", "unexpected exception code");
    check(unexpectedBody.request_id === requestId, "unexpected exception request_id");
    check(errors.some((line) => line.includes(`request_id=${requestId}`)), "unexpected log has request_id");
    check(!errors.some((line) => line.includes("secret fixture value")), "unexpected log is redacted");
  } finally {
    console.error = originalError;
  }
} finally {
  harness.close();
}

console.log(`API 契约检查通过：${assertions} 项断言`);
