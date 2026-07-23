import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";

import {
  deliverExistingChromeSession,
  ChromeDevToolsLoginBridge,
  ExistingChromeLoginBridge,
  SafeCookieJar,
  SessionExpiredError,
  TapdSessionManager,
  WorkspaceContextRequiredError,
  type ExistingChromeSessionCapture,
  type ExistingChromeSessionHandoff,
} from "../src/session/index.js";

const workspaceId = "56450277";

function syntheticCapture(overrides: Partial<ExistingChromeSessionCapture> = {}): ExistingChromeSessionCapture {
  return {
    workspaceId,
    sourceOrigin: "https://www.tapd.cn",
    cookies: [
      {
        name: "tapd_session",
        value: "synthetic-cookie-secret",
        domain: ".tapd.cn",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ],
    dscToken: "synthetic-dsc-secret",
    storyContext: { confId: "101", queryToken: "story-query-secret", workitemTypeId: "201" },
    bugContext: { confId: "102", queryToken: "bug-query-secret" },
    ...overrides,
  };
}

function requireHandoff(value: unknown): ExistingChromeSessionHandoff {
  assert.ok(value && typeof value === "object" && "handoff" in value);
  const handoff = (value as { handoff?: ExistingChromeSessionHandoff }).handoff;
  assert.ok(handoff);
  return handoff;
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(() => access(path));
}

test("SafeCookieJar is TAPD-only and never serializes cookie values", () => {
  const jar = SafeCookieJar.fromCookies([
    { name: "tapd_session", value: "synthetic-cookie-secret", domain: ".tapd.cn", path: "/", secure: true },
    { name: "ignored", value: "outside-secret", domain: ".example.com", path: "/" },
  ]);

  assert.equal(jar.getCookieHeader("https://www.tapd.cn/api/entity/bugs/get_info"), "tapd_session=synthetic-cookie-secret");
  assert.throws(() => jar.getCookieHeader("https://example.com/"), TypeError);
  const json = JSON.stringify(jar);
  assert.equal(json.includes("synthetic-cookie-secret"), false);
  assert.equal(json.includes("outside-secret"), false);
  assert.match(json, /tapd_session/);
});

test("SessionManager enforces explicit numeric workspaces and the four session states", () => {
  let now = 1_000;
  const manager = new TapdSessionManager({ clock: () => now });
  assert.equal(manager.getState(workspaceId), "missing");
  assert.throws(() => manager.getState("test2"), WorkspaceContextRequiredError);

  manager.beginLogin(workspaceId);
  assert.equal(manager.getState(workspaceId), "waiting_for_login");
  manager.completeLogin(workspaceId, {
    workspaceId,
    cookieJar: SafeCookieJar.fromCookies([
      { name: "tapd_session", value: "synthetic-cookie-secret", domain: ".tapd.cn", path: "/", secure: true },
    ]),
    dscToken: "synthetic-dsc-secret",
    storyContext: { confId: "101", queryToken: "story-query-secret", workitemTypeId: "201" },
    bugContext: { confId: "102", queryToken: "bug-query-secret" },
    expiresAt: 2_000,
  });

  assert.equal(manager.getState(workspaceId), "valid");
  const request = manager.getRequestContext(workspaceId, "https://www.tapd.cn/api/entity/stories/get_info");
  assert.equal(request.storyContext?.confId, "101");
  assert.equal(request.bugContext?.confId, "102");
  assert.equal(request.cookieHeader.includes("synthetic-cookie-secret"), true);

  now = 2_001;
  assert.equal(manager.getState(workspaceId), "expired");
  assert.throws(() => manager.getRequestContext(workspaceId), SessionExpiredError);
  manager.clear(workspaceId);
  assert.equal(manager.getState(workspaceId), "missing");
});

test("Chrome DevTools refresh captures one TAPD session for direct API use", async () => {
  const manager = new TapdSessionManager();
  let closed = false;
  const bridge = new ChromeDevToolsLoginBridge({
    sessionManager: manager,
    browser: {
      captureWorkspace: async (requestedWorkspaceId) => ({
        workspaceId: requestedWorkspaceId,
        cookies: syntheticCapture().cookies,
        dscToken: "synthetic-dsc-secret",
        storyContext: { confId: "101", queryToken: "story-query-secret", workitemTypeId: "201" },
        bugContext: { confId: "102", queryToken: "bug-query-secret" },
      }),
      close: async () => { closed = true; },
    },
  });

  const waiting = await bridge.begin(workspaceId);
  assert.equal(waiting.state, "waiting_for_login");
  assert.equal(waiting.browserMode, "chrome_devtools");
  const ready = await bridge.complete(workspaceId);
  assert.equal(ready.state, "valid");
  const captured = manager.requireValidContext(workspaceId);
  assert.deepEqual(captured.storyContext, { confId: "101", queryToken: "story-query-secret", workitemTypeId: "201" });
  assert.equal(captured.cookieJar.getCookieHeader().includes("synthetic-cookie-secret"), true);
  assert.equal(manager.getRequestContext(workspaceId).dscToken, "synthetic-dsc-secret");
  await bridge.close();
  assert.equal(closed, true);
});

test("existing Chrome bridge accepts one memory-only TAPD handoff without opening a browser", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager, loginTimeoutMs: 5_000 });

  const first = await bridge.begin(workspaceId);
  const second = await bridge.begin(workspaceId);
  const handoff = requireHandoff(first);
  assert.deepEqual(second.handoff, handoff);
  assert.equal(first.state, "waiting_for_login");
  assert.equal(first.pageOpen, false);
  assert.equal(first.browserMode, "existing_chrome");
  assert.equal(first.captureReceived, false);
  assert.equal(first.loginUrl?.includes(`/${workspaceId}/`), true);
  assert.deepEqual((await readdir(dirname(handoff.requestPipePath))).sort(), ["capture.in", "capture.out"]);

  const publicStatus = JSON.stringify(first);
  assert.equal(publicStatus.includes("synthetic-cookie-secret"), false);
  assert.equal(publicStatus.includes("synthetic-dsc-secret"), false);
  await access(handoff.clientModulePath);

  const delivered = await deliverExistingChromeSession(handoff, syntheticCapture());
  assert.deepEqual(delivered, { accepted: true, workspaceId });
  assert.equal(bridge.getStatus(workspaceId).captureReceived, true);

  const completed = await bridge.complete(workspaceId);
  assert.equal(completed.state, "valid");
  assert.equal(completed.pageOpen, false);
  assert.equal(completed.cleanupPending, false);
  assert.equal(completed.handoff, undefined);
  await assertPathMissing(handoff.requestPipePath);

  const captured = manager.requireValidContext(workspaceId);
  assert.deepEqual(captured.storyContext, {
    confId: "101",
    queryToken: "story-query-secret",
    workitemTypeId: "201",
  });
  assert.deepEqual(captured.bugContext, {
    confId: "102",
    queryToken: "bug-query-secret",
    workitemTypeId: undefined,
  });
  assert.equal(captured.cookieJar.getCookieHeader().includes("synthetic-cookie-secret"), true);
  await bridge.close();
});

test("existing Chrome client rejects cookies outside tapd.cn before transmitting", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager });
  const status = await bridge.begin(workspaceId);
  const handoff = requireHandoff(status);

  assert.throws(
    () => deliverExistingChromeSession(handoff, syntheticCapture({
      cookies: [{ name: "outside", value: "outside-secret", domain: ".example.com", path: "/" }],
    })),
    /outside tapd\.cn/,
  );
  assert.equal(bridge.getStatus(workspaceId).captureReceived, false);
  await bridge.cancel(workspaceId);
  await assertPathMissing(handoff.requestPipePath);
});

test("existing Chrome bridge requires a delivered capture before complete", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager });
  const status = await bridge.begin(workspaceId);
  const handoff = requireHandoff(status);

  await assert.rejects(() => bridge.complete(workspaceId), /has not handed off/);
  assert.equal(manager.getState(workspaceId), "waiting_for_login");
  assert.equal(bridge.getStatus(workspaceId).cleanupPending, true);
  await bridge.cancel(workspaceId);
  await assertPathMissing(handoff.requestPipePath);
});

test("existing Chrome bridge permits only one pending workspace", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager });
  const status = await bridge.begin(workspaceId);
  const handoff = requireHandoff(status);

  await assert.rejects(() => bridge.begin("46163983"), /already waiting/);
  assert.equal(manager.getState("46163983"), "missing");
  await bridge.cancel(workspaceId);
  await assertPathMissing(handoff.requestPipePath);
});

test("existing Chrome handoff timeout removes the socket and restores the prior state", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager, loginTimeoutMs: 10 });
  const missingStatus = await bridge.begin(workspaceId);
  const missingHandoff = requireHandoff(missingStatus);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getState(workspaceId), "missing");
  assert.equal(bridge.getStatus(workspaceId).cleanupPending, false);
  await assertPathMissing(missingHandoff.requestPipePath);

  manager.completeLogin(workspaceId, {
    workspaceId,
    cookieJar: SafeCookieJar.fromCookies(syntheticCapture().cookies),
    dscToken: "original-dsc-secret",
  });
  const refreshStatus = await bridge.begin(workspaceId);
  const refreshHandoff = requireHandoff(refreshStatus);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getState(workspaceId), "valid");
  assert.equal(manager.getRequestContext(workspaceId).dscToken, "original-dsc-secret");
  await assertPathMissing(refreshHandoff.requestPipePath);
});

test("cancelling after delivery discards the pending Chrome capture", async () => {
  const manager = new TapdSessionManager();
  const bridge = new ExistingChromeLoginBridge({ sessionManager: manager });
  const status = await bridge.begin(workspaceId);
  const handoff = requireHandoff(status);
  await deliverExistingChromeSession(handoff, syntheticCapture());
  assert.equal(bridge.getStatus(workspaceId).captureReceived, true);

  const cancelled = await bridge.cancel(workspaceId);
  assert.equal(cancelled.state, "missing");
  assert.equal(cancelled.cleanupPending, false);
  assert.throws(() => manager.requireValidContext(workspaceId), WorkspaceContextRequiredError);
  await assertPathMissing(handoff.requestPipePath);
});
