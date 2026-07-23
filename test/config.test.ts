import assert from "node:assert/strict";
import test from "node:test";

import { loadTapdConfig, requireWorkspaceId, TapdConfigurationError } from "../src/config.js";

test("starts without Open API credentials or a default workspace", () => {
  const config = loadTapdConfig({});

  assert.equal(config.webBaseUrl, "https://www.tapd.cn");
  assert.equal("apiUser" in config, false);
  assert.equal("apiPassword" in config, false);
  assert.equal("defaultWorkspaceId" in config, false);
  assert.equal("chromeExecutablePath" in config, false);
  assert.equal("sessionHandoffTimeoutMs" in config, false);
  assert.equal(config.userPromptPath, undefined);
});

test("accepts an optional user-authored business prompt path", () => {
  const config = loadTapdConfig({
    TAPD_USER_PROMPT_PATH: " /tmp/tapd-work-item-guidance.md ",
    TAPD_SESSION_STORE_PATH: " /tmp/tapd-session.json ",
    TAPD_CHROME_USER_DATA_DIR: " /tmp/chrome-user-data ",
  });

  assert.equal(config.userPromptPath, "/tmp/tapd-work-item-guidance.md");
  assert.equal(config.sessionStorePath, "/tmp/tapd-session.json");
  assert.equal(config.chromeUserDataDir, "/tmp/chrome-user-data");
});

test("requires every workspace id to be an explicit numeric string", () => {
  assert.equal(requireWorkspaceId(" 56450277 "), "56450277");
  assert.throws(() => requireWorkspaceId("0"), /positive numeric string/);
  assert.throws(() => requireWorkspaceId(""), TapdConfigurationError);
  assert.throws(() => requireWorkspaceId("test2"), TapdConfigurationError);
});

test("does not allow the Web API base URL to escape the TAPD origin", () => {
  assert.throws(
    () => loadTapdConfig({ TAPD_WEB_BASE_URL: "https://example.com" }),
    (error: unknown) => error instanceof TapdConfigurationError && error.message.includes("www.tapd.cn"),
  );
});
