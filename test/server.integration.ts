import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TapdApplication, type TapdApplicationDependencies } from "../src/application.js";
import {
  AdvanceInput,
  CreateBugInput,
  CreateStoryInput,
  DeleteWorkItemInput,
  ListWorkItemsInput,
  TapdToolFacade,
  TransitionInput,
  UpdateWorkItemInput,
  WorkflowInput,
  createTapdServer,
} from "../src/server.js";

const workspaceId = "56450277";

function facade(overrides: Partial<TapdToolFacade> = {}): TapdToolFacade {
  return {
    sessionStatus: (workspaceIdInput: string) => ({ workspaceId: workspaceIdInput, state: "missing" }),
    refreshSession: async (input) => ({ state: input.action === "begin" ? "waiting_for_login" : "valid" }),
    listStories: async (input: ListWorkItemsInput) => ({ entityType: "story", workspaceId: input.workspaceId, items: [] }),
    getStory: async (input: WorkflowInput) => ({ entityType: "story", workspaceId: input.workspaceId, id: input.id }),
    getStoryFields: async (workspaceIdInput: string) => ({ entityType: "story", workspaceId: workspaceIdInput, fields: [] }),
    createStory: async (input: CreateStoryInput) => ({
      entityType: "story",
      workspaceId: input.workspaceId,
      id: "1156450277001000001",
      title: input.name,
    }),
    updateStory: async (input: UpdateWorkItemInput) => ({ entityType: "story", ...input }),
    deleteStory: async (input: DeleteWorkItemInput) => ({ ...input, deleted: true }),
    listBugs: async (input: ListWorkItemsInput) => ({ entityType: "bug", workspaceId: input.workspaceId, items: [] }),
    getBug: async (input: WorkflowInput) => ({ entityType: "bug", workspaceId: input.workspaceId, id: input.id }),
    getBugFields: async (workspaceIdInput: string) => ({ entityType: "bug", workspaceId: workspaceIdInput, fields: [] }),
    searchMembers: async (input) => ({ workspaceId: input.workspaceId, candidates: [] }),
    formatBugReport: async () => "## 预期结果\n\n【待补充】",
    createBug: async (input: CreateBugInput) => ({
      entityType: "bug",
      workspaceId: input.workspaceId,
      id: "1156450277001000002",
      title: input.title,
    }),
    updateBug: async (input: UpdateWorkItemInput) => ({ entityType: "bug", ...input }),
    deleteBug: async (input: DeleteWorkItemInput) => ({ ...input, deleted: true }),
    resolveWorkItem: async (input: WorkflowInput) => ({ ...input, fullId: input.id }),
    getTransitions: async (input: WorkflowInput) => ({ ...input, transitions: [] }),
    transition: async (input: TransitionInput) => ({ ...input, status: input.targetStatus }),
    advance: async (input: AdvanceInput) => ({ ...input, requiresChoice: true, candidates: [] }),
    addComment: async (input) => ({ ...input, commentId: "1" }),
    ...overrides,
  };
}

async function connectedClient(toolFacade: TapdToolFacade, userBusinessPrompt?: string): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const server = createTapdServer(toolFacade, { userBusinessPrompt });
  const client = new Client({ name: "tapd-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

test("publishes the complete session, CRUD, workflow, resolver, and comment surface", async () => {
  const connection = await connectedClient(facade());
  try {
    const listed = await connection.client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const expected of [
      "tapd_session_status",
      "tapd_refresh_session",
      "tapd_list_stories",
      "tapd_get_story",
      "tapd_get_story_fields",
      "tapd_create_story",
      "tapd_update_story",
      "tapd_delete_story",
      "tapd_list_bugs",
      "tapd_get_bug",
      "tapd_get_bug_fields",
      "tapd_search_members",
      "tapd_format_bug_report",
      "tapd_create_bug",
      "tapd_update_bug",
      "tapd_delete_bug",
      "tapd_resolve_work_item_id",
      "tapd_get_transitions",
      "tapd_transition_work_item",
      "tapd_advance_to_next_step",
      "tapd_add_comment",
    ]) {
      assert.equal(names.has(expected), true, `missing ${expected}`);
    }

    for (const tool of listed.tools) {
      const schema = tool.inputSchema as { required?: string[] };
      assert.equal(schema.required?.includes("workspace_id"), true, `${tool.name} must require workspace_id`);
    }

    for (const name of ["tapd_delete_story", "tapd_delete_bug"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.equal(tool?.annotations?.destructiveHint, true);
      assert.equal((tool?.inputSchema as { required?: string[] }).required?.includes("confirm"), true);
    }
  } finally {
    await connection.close();
  }
});

test("publishes model-facing usage instructions and descriptions for every parameter", async () => {
  const connection = await connectedClient(facade());
  try {
    assert.equal(connection.client.getServerVersion()?.version, "0.4.0");
    const instructions = connection.client.getInstructions();
    assert.match(instructions ?? "", /Omit unknown optional parameters/);
    assert.match(instructions ?? "", /do not feed its output back into tapd_create_bug\.description/);
    assert.match(instructions ?? "", /Use workflow tools, never fields\.status/);

    const listed = await connection.client.listTools();
    for (const tool of listed.tools) {
      assert.ok(tool.description?.trim(), `${tool.name} must publish a tool description`);
      const properties = (tool.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }).properties ?? {};
      for (const [name, schema] of Object.entries(properties)) {
        assert.ok(schema.description?.trim(), `${tool.name}.${name} must publish a parameter description`);
      }
    }

    const createBug = listed.tools.find((tool) => tool.name === "tapd_create_bug");
    assert.match(createBug?.description ?? "", /omit unknown optional environment fields/);
    const bugProperties = (createBug?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    assert.match(bugProperties.expected_result?.description ?? "", /do not invent/);
    assert.match(bugProperties.product_version?.description ?? "", /Omit when unknown/);
    assert.match(bugProperties.attachment_evidence?.description ?? "", /never pass 截图见附件/);
    assert.match(bugProperties.image_paths?.description ?? "", /never pass a placeholder path/);

    const mentionSearch = listed.tools.find((tool) => tool.name === "tapd_search_members");
    assert.match(mentionSearch?.description ?? "", /@mention/);
    const addComment = listed.tools.find((tool) => tool.name === "tapd_add_comment");
    const commentProperties = (addComment?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    assert.match(commentProperties.mentions?.description ?? "", /may notify/);
  } finally {
    await connection.close();
  }
});

test("appends an optional user-authored business prompt without adding a default", async () => {
  const withoutPrompt = await connectedClient(facade());
  const withPrompt = await connectedClient(facade(), "Use 【业务模块】【功能页面】标题。");
  try {
    assert.doesNotMatch(withoutPrompt.client.getInstructions() ?? "", /业务模块/);
    assert.match(withPrompt.client.getInstructions() ?? "", /Use 【业务模块】【功能页面】标题。/);
  } finally {
    await withoutPrompt.close();
    await withPrompt.close();
  }
});

test("rejects a missing or non-numeric workspace before calling a business service", async () => {
  let calls = 0;
  const connection = await connectedClient(
    facade({
      listStories: async () => {
        calls += 1;
        return [];
      },
    }),
  );
  try {
    const missing = await connection.client.callTool({ name: "tapd_list_stories", arguments: {} });
    const named = await connection.client.callTool({
      name: "tapd_list_stories",
      arguments: { workspace_id: "test2" },
    });
    assert.equal(missing.isError, true);
    assert.equal(named.isError, true);
    assert.equal(calls, 0);
  } finally {
    await connection.close();
  }
});

test("publishes and forwards rich-text image paths for Bug creation", async () => {
  let received: CreateBugInput | undefined;
  const connection = await connectedClient(facade({
    createBug: async (input) => {
      received = input;
      return { id: "1" };
    },
  }));
  try {
    const tools = await connection.client.listTools();
    const schema = tools.tools.find((tool) => tool.name === "tapd_create_bug")?.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(schema.properties?.image_paths);
    const result = await connection.client.callTool({
      name: "tapd_create_bug",
      arguments: {
        workspace_id: workspaceId,
        title: "Bug with image",
        single_issue_confirmed: true,
        image_paths: ["/tmp/screenshot.png"],
      },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(received?.imagePaths, ["/tmp/screenshot.png"]);
  } finally {
    await connection.close();
  }
});

test("publishes and forwards local image paths for Story create and update", async () => {
  let created: CreateStoryInput | undefined;
  let updated: UpdateWorkItemInput | undefined;
  const connection = await connectedClient(facade({
    createStory: async (input) => {
      created = input;
      return { id: "1" };
    },
    updateStory: async (input) => {
      updated = input;
      return { id: input.id };
    },
  }));
  try {
    const tools = await connection.client.listTools();
    for (const name of ["tapd_create_story", "tapd_update_story"]) {
      const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown> };
      assert.ok(schema.properties?.image_paths, `${name} must expose image_paths`);
    }
    await connection.client.callTool({
      name: "tapd_create_story",
      arguments: { workspace_id: workspaceId, name: "Story image", image_paths: ["/tmp/story.png"] },
    });
    await connection.client.callTool({
      name: "tapd_update_story",
      arguments: { workspace_id: workspaceId, id: "1", image_paths: ["/tmp/story-update.png"] },
    });
    assert.deepEqual(created?.imagePaths, ["/tmp/story.png"]);
    assert.deepEqual(updated?.imagePaths, ["/tmp/story-update.png"]);
  } finally {
    await connection.close();
  }
});

test("returns only standardized Markdown from the Bug formatter tool", async () => {
  const expected = [
    "## 复现步骤",
    "",
    "1. 【待补充】",
    "2. 【待补充】",
    "3. 【待补充】",
    "",
    "## 预期结果",
    "",
    "【待补充】",
    "",
    "## 实际结果",
    "",
    "保存按钮点击后页面无响应",
    "",
    "## 附件证据",
    "",
    "【待补充截图证据】",
  ].join("\n");
  const connection = await connectedClient(facade({ formatBugReport: async () => expected }));
  try {
    const result = await connection.client.callTool({
      name: "tapd_format_bug_report",
      arguments: {
        workspace_id: workspaceId,
        description: "保存按钮点击后页面无响应",
        single_issue_confirmed: true,
      },
    });
    assert.notEqual(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;
    assert.equal(text, expected);
    assert.equal(text.startsWith("{"), false);
  } finally {
    await connection.close();
  }
});

test("requires and propagates confirm=true before either delete facade can run", async () => {
  const deleteInputs: DeleteWorkItemInput[] = [];
  const application = new TapdApplication({
    stories: {
      delete: async (input: { workspaceId: string; id: string; confirm: boolean }) => {
        deleteInputs.push({ ...input, entityType: "story" });
        return { deleted: true };
      },
    },
    bugs: {
      delete: async (input: { workspaceId: string; id: string; confirm: boolean }) => {
        deleteInputs.push({ ...input, entityType: "bug" });
        return { deleted: true };
      },
    },
  } as unknown as TapdApplicationDependencies);
  const connection = await connectedClient(application);
  try {
    for (const name of ["tapd_delete_story", "tapd_delete_bug"]) {
      const missing = await connection.client.callTool({
        name,
        arguments: { workspace_id: workspaceId, id: "1" },
      });
      const falseConfirmation = await connection.client.callTool({
        name,
        arguments: { workspace_id: workspaceId, id: "1", confirm: false },
      });
      assert.equal(missing.isError, true);
      assert.equal(falseConfirmation.isError, true);
    }
    assert.equal(deleteInputs.length, 0);

    for (const name of ["tapd_delete_story", "tapd_delete_bug"]) {
      const result = await connection.client.callTool({
        name,
        arguments: { workspace_id: workspaceId, id: "1", confirm: true },
      });
      assert.notEqual(result.isError, true);
    }
    assert.deepEqual(deleteInputs, [
      { workspaceId, entityType: "story", id: "1", confirm: true },
      { workspaceId, entityType: "bug", id: "1", confirm: true },
    ]);

    await application.deleteStory({ workspaceId, entityType: "story", id: "2", confirm: false });
    await application.deleteBug({ workspaceId, entityType: "bug", id: "3", confirm: false });
    assert.deepEqual(deleteInputs.slice(2), [
      { workspaceId, entityType: "story", id: "2", confirm: false },
      { workspaceId, entityType: "bug", id: "3", confirm: false },
    ]);
  } finally {
    await connection.close();
  }
});

test("sanitizes sensitive values from successful results and structured errors", async () => {
  const secretValues = ["cookie-secret-value", "dsc-secret-value", "query-secret-value", "recovery-secret-value"];
  const connection = await connectedClient(
    facade({
      createStory: async () => ({
        id: "1",
        cookie: secretValues[0],
        nested: {
          dsc_token: secretValues[1],
          query_token: secretValues[2],
          recovery_key: secretValues[3],
        },
      }),
      getBug: async () => {
        const error = new Error(`request failed cookie=${secretValues[0]}`) as Error & {
          code: string;
          details: Record<string, string>;
        };
        error.code = "TAPD_REQUEST_FAILED";
        error.details = { dsc_token: secretValues[1], query_token: secretValues[2] };
        throw error;
      },
    }),
  );
  try {
    const success = await connection.client.callTool({
      name: "tapd_create_story",
      arguments: { workspace_id: workspaceId, name: "safe output test" },
    });
    const failure = await connection.client.callTool({
      name: "tapd_get_bug",
      arguments: { workspace_id: workspaceId, id: "1" },
    });
    const output = JSON.stringify([success, failure]);
    for (const secret of secretValues) assert.equal(output.includes(secret), false);
    assert.equal(failure.isError, true);
  } finally {
    await connection.close();
  }
});
