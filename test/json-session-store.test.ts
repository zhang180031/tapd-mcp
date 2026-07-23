import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonSessionStore } from "../src/session/json-session-store.js";
import { SafeCookieJar } from "../src/session/cookie-jar.js";
import { TapdSessionManager } from "../src/session/session-manager.js";

const workspaceId = "46163983";

test("persists a TAPD-only session and restores it for direct requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "tapd-mcp-session-"));
  const path = join(directory, "session.json");
  try {
    const store = new JsonSessionStore(path);
    const manager = new TapdSessionManager({
      onSessionChanged: (id, context) => {
        if (context) store.save(context);
        else store.remove(id);
      },
    });
    manager.completeLogin(workspaceId, {
      workspaceId,
      cookieJar: SafeCookieJar.fromCookies([
        { name: "tapd_session", value: "synthetic-cookie-secret", domain: ".tapd.cn", path: "/", secure: true, httpOnly: true },
      ]),
      dscToken: "synthetic-dsc-secret",
      storyContext: { confId: "101", queryToken: "synthetic-query-secret" },
    });

    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"version":1/);
    const restored = new JsonSessionStore(path).load();
    assert.equal(restored.length, 1);

    const restoredManager = new TapdSessionManager();
    restoredManager.completeLogin(restored[0].workspaceId ?? "", restored[0]);
    const request = restoredManager.getRequestContext(workspaceId);
    assert.equal(request.cookieHeader, "tapd_session=synthetic-cookie-secret");
    assert.equal(request.dscToken, "synthetic-dsc-secret");
    assert.equal(request.storyContext?.confId, "101");

    manager.markExpired(workspaceId);
    const afterExpiry = JSON.parse(readFileSync(path, "utf8")) as { workspaces: Record<string, unknown> };
    assert.deepEqual(afterExpiry.workspaces, {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("treats a corrupt local session file as absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "tapd-mcp-session-"));
  const path = join(directory, "session.json");
  try {
    writeFileSync(path, "{not-json", "utf8");
    assert.deepEqual(new JsonSessionStore(path).load(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a legacy cached session without list context to TAPD's default view", () => {
  const directory = mkdtempSync(join(tmpdir(), "tapd-mcp-session-"));
  const path = join(directory, "session.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      workspaces: {
        [workspaceId]: {
          cookies: [{ name: "tapd_session", value: "synthetic-cookie-secret", domain: ".tapd.cn", path: "/", secure: true }],
          dscToken: "synthetic-dsc-secret",
          capturedAt: 1,
        },
      },
    }), "utf8");

    const [restored] = new JsonSessionStore(path).load();
    assert.deepEqual(restored.storyContext, { confId: "" });
    assert.deepEqual(restored.bugContext, { confId: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
