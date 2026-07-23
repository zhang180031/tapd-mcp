import assert from "node:assert/strict";
import test from "node:test";

import { selectTapdPageForSessionCapture } from "../src/session/chrome-devtools-session-capturer.js";
import { WorkspaceContextService } from "../src/services/workspace-context-service.js";

test("prefers the requested workspace when selecting a TAPD page for session capture", () => {
  const page = selectTapdPageForSessionCapture([
    { type: "page", targetId: "other", url: "https://www.tapd.cn/tapd_fe/56450277/story/list?useScene=storyList&conf_id=101" },
    { type: "page", targetId: "requested", url: "https://www.tapd.cn/tapd_fe/46163983/bug/list?useScene=bugList&conf_id=102" },
  ], "46163983");

  assert.deepEqual(page, {
    targetId: "requested",
    url: "https://www.tapd.cn/tapd_fe/46163983/bug/list?useScene=bugList&conf_id=102",
    workspaceMatched: true,
  });
});

test("uses another TAPD work-item page only for account session capture", () => {
  const page = selectTapdPageForSessionCapture([
    { type: "page", targetId: "outside", url: "https://example.com/" },
    { type: "page", targetId: "tapd", url: "https://www.tapd.cn/tapd_fe/56450277/story/list?useScene=storyList" },
  ], "46163983");

  assert.deepEqual(page, {
    targetId: "tapd",
    url: "https://www.tapd.cn/tapd_fe/56450277/story/list?useScene=storyList",
    workspaceMatched: false,
  });
});

test("does not select non-work-item TAPD pages", () => {
  const page = selectTapdPageForSessionCapture([
    { type: "page", targetId: "home", url: "https://www.tapd.cn/my_worktable" },
    { type: "page", targetId: "outside", url: "https://example.com/" },
  ], "46163983");

  assert.equal(page, undefined);
});

test("keeps an explicit empty captured conf_id as a valid default list context", () => {
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession("46163983", "story", { confId: "" });

  assert.deepEqual(contexts.resolveListContext("46163983", "story"), { confId: "" });
});
