import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadUserBusinessPrompt } from "../src/user-business-prompt.js";

test("does not require a user business prompt file", () => {
  assert.equal(loadUserBusinessPrompt(undefined), undefined);
  assert.equal(loadUserBusinessPrompt("/definitely/not/a/tapd-prompt.md"), undefined);
});

test("loads non-empty user-authored business guidance", () => {
  const directory = mkdtempSync(join(tmpdir(), "tapd-mcp-prompt-"));
  const path = join(directory, "guidance.md");
  try {
    writeFileSync(path, "\n# My work-item rules\n\nUse my title convention.\n", "utf8");
    assert.equal(loadUserBusinessPrompt(path), "# My work-item rules\n\nUse my title convention.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
