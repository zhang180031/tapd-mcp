import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("built stdio server exposes tools without credentials or non-protocol stdout", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/index.js")],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "tapd-stdio-integration", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "tapd_create_story"), true);
    const status = await client.callTool({
      name: "tapd_session_status",
      arguments: { workspace_id: "56450277" },
    });
    assert.equal(status.isError, undefined);
    const content = (status as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content.find((entry) => entry.type === "text");
    assert.equal(text?.type, "text");
    if (text?.type === "text" && text.text) {
      const payload = JSON.parse(text.text) as { data?: { state?: string } };
      assert.equal(payload.data?.state, "missing");
    }
  } finally {
    await client.close();
  }

  assert.equal(stderr.trim(), "");
});
