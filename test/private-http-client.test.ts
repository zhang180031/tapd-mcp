import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractChangedError,
  ChromeDevToolsPrivateHttpClient,
  PrivateHttpClient,
  SessionExpiredError,
  TapdRequestError,
  WriteOutcomeUnknownError,
  responseShapeFingerprint,
} from "../src/private-api/index.js";
import { TapdSessionManager } from "../src/session/session-manager.js";

const workspaceId = "56450277";
const fastOptions = { timeoutMs: 1_000, maxRequestsPerMinute: 1_000_000 } as const;

function sessionProvider(overrides: Record<string, unknown> = {}) {
  return {
    getRequestContext: async (requestedWorkspaceId: string) => ({
      workspaceId: requestedWorkspaceId,
      cookieHeader: "tapd_session=synthetic-cookie-secret",
      dscToken: "synthetic-dsc-secret",
    }),
    markExpired: async () => undefined,
    mergeSetCookieHeaders: async () => undefined,
    ...overrides,
  };
}

function success(data: unknown = { value: true }, code: string | number = "0"): Response {
  return new Response(JSON.stringify({ data, meta: { code, message: "success" }, request_id: "request-1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("injects the in-memory session into same-origin GET and POST requests", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    calls.push({ url: new URL(input.toString()), init });
    return success({ id: "1" }, calls.length === 1 ? "0" : 0);
  };
  const client = new PrivateHttpClient(sessionProvider(), fetchMock, fastOptions);

  const read = await client.get({
    workspaceId,
    endpoint: "stories.get_info",
    path: "/api/entity/stories/get_info",
    query: { workspace_id: workspaceId, story_id: "1" },
    parse: (payload) => payload,
  });
  const write = await client.post({
    workspaceId,
    endpoint: "stories.quickly_create",
    path: "/api/entity/stories/quickly_create",
    body: { workspace_id: workspaceId, name: "test" },
    parse: (payload) => payload,
  });

  assert.equal(read.requestId, "request-1");
  assert.equal(write.requestId, "request-1");
  assert.equal(calls[0].url.origin, "https://www.tapd.cn");
  assert.equal(calls[0].url.searchParams.has("dsc_token"), false);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(new Headers(calls[0].init.headers).get("cookie"), "tapd_session=synthetic-cookie-secret");
  assert.equal(new Headers(calls[1].init.headers).get("origin"), "https://www.tapd.cn");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    workspace_id: workspaceId,
    name: "test",
    dsc_token: "synthetic-dsc-secret",
  });
});

test("uses the Chrome page transport without exporting Cookie or dsc_token values", async () => {
  const sessions = new TapdSessionManager();
  sessions.completeChromeDevToolsLogin(workspaceId, { workspaceId, storyContext: { confId: "101" } });
  const requests: Array<{ method: string; url: string; jsonBody?: Readonly<Record<string, unknown>> }> = [];
  const client = new ChromeDevToolsPrivateHttpClient(sessions, {
    captureWorkspace: async () => ({ workspaceId }),
    request: async (request) => {
      requests.push(request);
      return { status: 200, text: JSON.stringify({ data: { id: "1" }, meta: { code: 0 }, request_id: "browser-request-1" }) };
    },
    close: async () => undefined,
  }, fastOptions);

  const result = await client.post({
    workspaceId,
    endpoint: "stories.quickly_create",
    path: "/api/entity/stories/quickly_create",
    body: { workspace_id: workspaceId, name: "test" },
    parse: (payload) => payload,
  });

  assert.equal(result.requestId, "browser-request-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(new URL(requests[0].url).origin, "https://www.tapd.cn");
  assert.deepEqual(requests[0].jsonBody, { workspace_id: workspaceId, name: "test" });
  assert.equal(JSON.stringify(requests[0]).includes("dsc_token"), false);
  assert.equal(JSON.stringify(requests[0]).includes("cookie"), false);
});

test("uploads editor images through the verified TAPD multipart endpoint", async () => {
  let captured: { url: URL; init: RequestInit } | undefined;
  const client = new PrivateHttpClient(sessionProvider(), async (input, init = {}) => {
    captured = { url: new URL(input.toString()), init };
    return success({ file_path: `/tfl/captures/2026-07/tapd_${workspaceId}_base64_1.png` });
  }, fastOptions);

  const result = await client.uploadEditorImage({
    workspaceId,
    bytes: Buffer.from([137, 80, 78, 71]),
    mimeType: "image/png",
  });

  assert.equal(result.value, `/tfl/captures/2026-07/tapd_${workspaceId}_base64_1.png`);
  assert.equal(captured?.url.origin, "https://tdl.tapd.cn");
  assert.equal(captured?.url.pathname, "/tbl/apis/qmeditor_upload.php");
  assert.equal(captured?.url.searchParams.get("image_prefix"), `tapd_${workspaceId}_`);
  assert.equal(new Headers(captured?.init.headers).has("cookie"), false);
  assert.ok(captured?.init.body instanceof FormData);
  assert.equal((captured?.init.body as FormData).get("from"), "snapscreen");
  assert.equal((captured?.init.body as FormData).get("base64"), "true");
  assert.equal((captured?.init.body as FormData).get("content"), "data:image/png;base64,iVBORw==");
});

test("rejects an image upload response outside the workspace-scoped captures path", async () => {
  const client = new PrivateHttpClient(sessionProvider(), async () => success({ file_path: "/etc/passwd" }), fastOptions);
  await assert.rejects(
    () => client.uploadEditorImage({ workspaceId, bytes: new Uint8Array([1]), mimeType: "image/png" }),
    (error: unknown) => error instanceof ContractChangedError,
  );
});

test("rejects cross-origin and non-api paths before fetch", async () => {
  let calls = 0;
  const client = new PrivateHttpClient(sessionProvider(), async () => {
    calls += 1;
    return success();
  }, fastOptions);

  await assert.rejects(
    () => client.get({ workspaceId, endpoint: "bad", path: "https://example.com/api/read", parse: (value) => value }),
    TypeError,
  );
  await assert.rejects(
    () => client.get({ workspaceId, endpoint: "bad", path: "/tapd_fe/123/story/list", parse: (value) => value }),
    TypeError,
  );
  assert.equal(calls, 0);
});

test("marks redirects, authentication responses, and login HTML as expired", async () => {
  let expired = 0;
  const provider = sessionProvider({ markExpired: async () => { expired += 1; } });
  const responses = [
    new Response("", { status: 302, headers: { location: "/login" } }),
    new Response("forbidden", { status: 403 }),
    new Response("<!doctype html><html><body>登录 TAPD</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  ];
  const client = new PrivateHttpClient(provider, async () => responses.shift()!, fastOptions);

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      () => client.get({ workspaceId, endpoint: "read", path: "/api/entity/stories/get_info", parse: (value) => value }),
      SessionExpiredError,
    );
  }
  assert.equal(expired, 3);
});

test("never retries writes and reports unknown outcomes for network, 5xx, and invalid responses", async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => { throw new Error("synthetic disconnect"); },
    async () => new Response("server error", { status: 503 }),
    async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
  ];

  for (const respond of cases) {
    let calls = 0;
    const client = new PrivateHttpClient(sessionProvider(), async () => {
      calls += 1;
      return respond();
    }, fastOptions);
    await assert.rejects(
      () => client.post({
        workspaceId,
        endpoint: "bugs.create",
        path: "/api/entity/bugs/create",
        body: { workspace_id: workspaceId },
        parse: (value) => value,
      }),
      (error: unknown) => error instanceof WriteOutcomeUnknownError && error.code === "WRITE_OUTCOME_UNKNOWN",
    );
    assert.equal(calls, 1);
  }
});

test("write contract drift includes only a bounded value-free response-shape fingerprint", async () => {
  const confidentialTitle = "Release the confidential lunar billing project";
  const confidentialId = "1156450277001999988";
  const confidentialUrl = "https://internal.example.test/tapd?token=top-secret";
  const secretValue = "synthetic-cookie-and-token-secret";
  const dynamicLongKey = `customer_supplied_${secretValue}_field_1156450277001999988`;
  const payload = {
    data: {
      created: true,
      items: [{
        accepted: false,
        id: confidentialId,
        title: confidentialTitle,
        target_url: confidentialUrl,
        safe_meta: { enabled: true, deeper: { ignored_value: "must-not-appear" } },
      }],
      [dynamicLongKey]: "must-not-appear",
    },
    meta: { code: 0, message: confidentialTitle, request_id: confidentialId },
    cookie: secretValue,
    dsc_token: secretValue,
    recovery_url: confidentialUrl,
    [confidentialUrl]: confidentialTitle,
  };
  let calls = 0;
  const client = new PrivateHttpClient(sessionProvider(), async () => {
    calls += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, fastOptions);

  let captured: WriteOutcomeUnknownError | undefined;
  await assert.rejects(
    () => client.post({
      workspaceId,
      endpoint: "stories.update",
      path: "/api/entity/inline_edit/story_update",
      body: { workspace_id: workspaceId },
      parse: () => { throw new ContractChangedError("stories.update", "known write response"); },
    }),
    (error: unknown) => {
      if (!(error instanceof WriteOutcomeUnknownError)) return false;
      captured = error;
      return true;
    },
  );

  assert.equal(calls, 1);
  assert.ok(captured);
  assert.equal(captured.code, "WRITE_OUTCOME_UNKNOWN");
  assert.equal(
    captured.message,
    "TAPD may have applied the write, but its result could not be confirmed. Query the work item before deciding whether to retry.",
  );
  const shape = captured.details.responseShape;
  assert.equal(typeof shape, "string");
  assert.match(String(shape), /^object\{/);
  assert.match(String(shape), /data:object/);
  assert.match(String(shape), /created:boolean/);
  assert.match(String(shape), /items:array<object/);
  assert.match(String(shape), /accepted:boolean/);
  assert.match(String(shape), /meta:object/);
  assert.match(String(shape), /code:number/);
  assert.match(String(shape), /message:string/);
  assert.ok(String(shape).length <= 320);

  for (const forbidden of [
    confidentialTitle,
    confidentialId,
    confidentialUrl,
    secretValue,
    dynamicLongKey,
    "must-not-appear",
  ]) {
    assert.equal(String(shape).includes(forbidden), false, `fingerprint leaked ${forbidden}`);
  }
  assert.doesNotMatch(String(shape), /cookie|token|recover|target_url|title:|request_id|\bid:/i);
  assert.equal(String(shape).includes(JSON.stringify(payload)), false);
});

test("unexpected write parser failures keep parser text private and still expose only the safe shape", async () => {
  const parserSecret = "parser leaked a confidential title and ID 1156450277001888877";
  const client = new PrivateHttpClient(
    sessionProvider(),
    async () => new Response(JSON.stringify({ data: { applied: true }, meta: { code: 0 } }), { status: 200 }),
    fastOptions,
  );

  await assert.rejects(
    () => client.post({
      workspaceId,
      endpoint: "bugs.update",
      path: "/api/entity/bugs/update",
      body: { workspace_id: workspaceId },
      parse: () => { throw new Error(parserSecret); },
    }),
    (error: unknown) => {
      if (!(error instanceof WriteOutcomeUnknownError)) return false;
      assert.equal(error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(error.message.includes(parserSecret), false);
      assert.equal(String(error.details.responseShape).includes(parserSecret), false);
      assert.match(String(error.details.responseShape), /data:object\{applied:boolean\}/);
      return true;
    },
  );
});

test("read contract drift includes the same bounded value-free response shape", async () => {
  const secretValue = "read-contract-secret-value";
  const client = new PrivateHttpClient(
    sessionProvider(),
    async () => new Response(JSON.stringify({
      data: {
        workflow_payload: {
          data: {
            current_status: "must-not-appear",
            transition_groups: [{ enabled: true, confidential_title: secretValue }],
          },
        },
      },
      meta: { code: 0 },
      cookie: secretValue,
    }), { status: 200 }),
    fastOptions,
  );

  await assert.rejects(
    () => client.get({
      workspaceId,
      endpoint: "story_aggregation.get_story_transition_info",
      path: "/api/aggregation/story_aggregation/get_story_transition_info",
      parse: () => { throw new ContractChangedError("story_aggregation.get_story_transition_info", "known transition response"); },
    }),
    (error: unknown) => {
      if (!(error instanceof ContractChangedError)) return false;
      const shape = String(error.details.responseShape);
      assert.match(shape, /workflow_payload:object/);
      assert.match(shape, /current_status:string/);
      assert.match(shape, /transition_groups:array/);
      assert.equal(shape.includes("must-not-appear"), false);
      assert.equal(shape.includes(secretValue), false);
      assert.doesNotMatch(shape, /cookie|confidential_title/i);
      return true;
    },
  );
});

test("response-shape fingerprint caps depth, width, length and omits unsafe dynamic keys", () => {
  const wideObject = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `safe_${String.fromCharCode(97 + index)}`,
      { next: { deeper: { deepest: true } } },
    ]),
  );
  const shape = responseShapeFingerprint({
    data: wideObject,
    status: "not-a-value-that-may-appear",
    short_key: null,
    "dynamic-business-key-that-is-far-too-long-to-be-static": "hidden",
    "https://private.example.test/path": "hidden",
    tapd_session: "hidden",
    rollback_secret: "hidden",
  });

  assert.ok(shape.length <= 320);
  assert.match(shape, /^object\{/);
  assert.match(shape, /data:object/);
  assert.match(shape, /\.\.\./);
  assert.match(shape, /short_key:null/);
  assert.match(shape, /status:string/);
  assert.equal(shape.includes("not-a-value-that-may-appear"), false);
  assert.equal(shape.includes("dynamic-business-key"), false);
  assert.doesNotMatch(shape, /https|session|rollback|hidden|deepest:true/i);
});

test("distinguishes known TAPD rejection and read-contract drift from unknown write outcomes", async () => {
  const knownRejection = new PrivateHttpClient(
    sessionProvider(),
    async () => new Response(JSON.stringify({ meta: { code: "400", message: "field rejected" } }), { status: 200 }),
    fastOptions,
  );
  await assert.rejects(
    () => knownRejection.post({
      workspaceId,
      endpoint: "stories.update",
      path: "/api/entity/inline_edit/story_update",
      body: {},
      parse: (value) => value,
    }),
    TapdRequestError,
  );

  const invalidRead = new PrivateHttpClient(
    sessionProvider(),
    async () => new Response("not-json", { status: 200 }),
    fastOptions,
  );
  await assert.rejects(
    () => invalidRead.get({
      workspaceId,
      endpoint: "stories.get_info",
      path: "/api/entity/stories/get_info",
      parse: (value) => value,
    }),
    ContractChangedError,
  );
});

test("merges only response Set-Cookie data through the session provider", async () => {
  const merged: string[][] = [];
  const provider = sessionProvider({
    mergeSetCookieHeaders: async (_workspaceId: string, values: readonly string[]) => { merged.push([...values]); },
  });
  const client = new PrivateHttpClient(
    provider,
    async () => new Response(JSON.stringify({ meta: { code: 0 }, data: {} }), {
      status: 200,
      headers: { "set-cookie": "tapd_session=rotated-synthetic; Path=/; Secure; HttpOnly" },
    }),
    fastOptions,
  );
  await client.get({
    workspaceId,
    endpoint: "stories.get_info",
    path: "/api/entity/stories/get_info",
    parse: (value) => value,
  });
  assert.equal(merged.length, 1);
  assert.match(merged[0][0], /^tapd_session=/);
});
