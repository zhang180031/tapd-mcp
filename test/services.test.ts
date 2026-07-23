import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PrivateHttpClient, WriteOutcomeUnknownError } from "../src/private-api/index.js";
import {
  BugService,
  MemberService,
  MissingWorkspaceContextError,
  StoryService,
  WorkflowService,
  WorkspaceContextService,
} from "../src/services/index.js";

const workspaceId = "56450277";

function clientWith(fetchImpl: typeof fetch): PrivateHttpClient {
  return new PrivateHttpClient(
    {
      getRequestContext: async (requestedWorkspaceId: string) => ({
        workspaceId: requestedWorkspaceId,
        cookieHeader: "tapd_session=synthetic-cookie-secret",
        dscToken: "synthetic-dsc-secret",
      }),
      markExpired: async () => undefined,
    },
    fetchImpl,
    { timeoutMs: 1_000, maxRequestsPerMinute: 1_000_000 },
  );
}

function response(data: unknown, code: string | number = "0"): Response {
  return new Response(JSON.stringify({ data, meta: { code, message: code === 0 || code === "0" ? "success" : "rejected" }, request_id: "request-1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function story(id = "1156450277001000001", overrides: Record<string, unknown> = {}) {
  return {
    id,
    short_id: "1000001",
    name: "Story title",
    status: "status_2",
    workspace_id: workspaceId,
    entity_type: "story",
    ...overrides,
  };
}

function bug(id = "1156450277001000002", overrides: Record<string, unknown> = {}) {
  return {
    id,
    short_id: "1000002",
    title: "Bug title",
    status: "new",
    workspace_id: workspaceId,
    entity_type: "bug",
    ...overrides,
  };
}

test("keeps Story and Bug list contexts isolated per explicit workspace", () => {
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession(workspaceId, "story", {
    confId: "101",
    queryToken: "story-query-secret",
    workitemTypeId: "201",
  });

  assert.equal(contexts.resolveListContext(workspaceId, "story").confId, "101");
  assert.throws(
    () => contexts.resolveListContext(workspaceId, "bug"),
    (error: unknown) => error instanceof MissingWorkspaceContextError && error.code === "WORKSPACE_CONTEXT_REQUIRED",
  );
  assert.equal(contexts.resolveStoryTypeId(workspaceId), "201");
  assert.throws(() => contexts.resolveListContext("test2", "story"));
});

test("treats an explicitly captured empty list context as present without leaking it across entities or workspaces", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = clientWith(async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({ items: [] });
  });
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession(workspaceId, "story", { confId: "", queryToken: "" });

  assert.deepEqual(contexts.resolveListContext(workspaceId, "story"), { confId: "", queryToken: "" });
  assert.equal(contexts.getPublicSummary(workspaceId).story.hasListContext, true);
  assert.throws(
    () => contexts.resolveListContext(workspaceId, "bug"),
    (error: unknown) => error instanceof MissingWorkspaceContextError && error.code === "WORKSPACE_CONTEXT_REQUIRED",
  );
  assert.throws(
    () => contexts.resolveListContext("56450278", "story"),
    (error: unknown) => error instanceof MissingWorkspaceContextError && error.code === "WORKSPACE_CONTEXT_REQUIRED",
  );

  await new StoryService(client, contexts).list({ workspaceId });
  assert.equal(calls[0].workspace_id, workspaceId);
  assert.equal(calls[0].conf_id, "");
  assert.equal(calls[0].query_token, "");
});

test("lists requirements with safe filters without allowing context or credential overrides", async () => {
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    calls.push({ url: new URL(input.toString()), body: JSON.parse(String(init?.body)) });
    return response({ items: [story()] });
  });
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession(workspaceId, "story", { confId: "101", queryToken: "story-query-secret" });
  const service = new StoryService(client, contexts);

  const result = await service.list({
    workspaceId,
    page: 2,
    perPage: 20,
    filters: { status: "status_2", owner: ["alice", "bob"] },
  });
  assert.equal(result.items.length, 1);
  assert.equal(calls[0].url.pathname, "/api/aggregation/story_aggregation/get_stories_list");
  assert.equal(calls[0].body.conf_id, "101");
  assert.equal(calls[0].body.query_token, "story-query-secret");
  assert.equal(calls[0].body.page, 2);
  assert.deepEqual(calls[0].body.owner, ["alice", "bob"]);
  assert.equal(calls[0].body.dsc_token, "synthetic-dsc-secret");

  await assert.rejects(
    () => service.list({ workspaceId, filters: { dsc_token: "attempted-override" } }),
    /not allowed/,
  );
  assert.equal(calls.length, 1);
});

test("appends uploaded local images to complete Story Markdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tapd-story-image-"));
  const imagePath = join(directory, "evidence.gif");
  // A valid one-pixel GIF fixture; it exists only for this test invocation.
  await writeFile(imagePath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  const writes: Record<string, unknown>[] = [];
  const client = clientWith(async (input, init) => {
    const url = new URL(input.toString());
    if (url.hostname === "tdl.tapd.cn") {
      return response({ file_path: `/tfl/captures/2026-07/tapd_${workspaceId}_base64_1.gif` });
    }
    if (url.pathname === "/api/entity/stories/get_info") {
      return response(story(undefined, { markdown_description: "## Existing requirement" }));
    }
    if (url.pathname === "/api/entity/inline_edit/story_update") {
      writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response(story(undefined, { markdown_description: "## Existing requirement" }));
    }
    throw new Error(`Unexpected TAPD request: ${url.pathname}`);
  });
  const service = new StoryService(client, new WorkspaceContextService());

  try {
    const result = await service.updateFields({ workspaceId, id: "1000001", fields: {}, imagePaths: [imagePath] });
    assert.deepEqual(result.appliedFields, ["description"]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].field, "markdown_description");
    assert.match(String(writes[0].value), /## Existing requirement/);
    assert.match(String(writes[0].value), /!\[附件证据 1\]\(\/tfl\/captures\/2026-07\/tapd_56450277_base64_1\.gif\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads Story and Bug field metadata through the context-free new-filter contract", async () => {
  const calls: Array<{ path: string; referer: string | null; body: Record<string, unknown> }> = [];
  const storyTypeId = "1156450277001000082";
  const client = clientWith(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({
      path: new URL(input.toString()).pathname,
      referer: new Headers(init?.headers).get("referer"),
      body,
    });
    const entityType = (body.entity_types as string[])[0];
    return response({
      fields: {
        [entityType]: [
          { field: "name", label: "标题", html_type: "text", required: true, editable: true },
        ],
      },
      meta: entityType === "story"
        ? { workitem_type_map: { [storyTypeId]: { id: storyTypeId, name: "需求" } } }
        : {},
    });
  });
  const contexts = new WorkspaceContextService();

  const storyFields = await new StoryService(client, contexts).getFields({ workspaceId });
  const bugFields = await new BugService(client, contexts).getFields({ workspaceId });

  assert.equal(storyFields.fields[0].name, "name");
  assert.equal(storyFields.workItemTypes[0].id, storyTypeId);
  assert.equal(bugFields.fields[0].name, "name");
  assert.deepEqual(calls, [
    {
      path: "/api/new_filter/new_filter/get_fields",
      referer: `https://www.tapd.cn/tapd_fe/${workspaceId}/story/list?useScene=storyList`,
      body: {
        workspace_id: workspaceId,
        selected_workspace_ids: [workspaceId],
        entity_types: ["story"],
        use_scene: "story_list",
        with_options: 0,
        is_workitem_type_menu: false,
        menu_workitem_type_id: "",
        program_id: "",
        app_id: "1",
        block_organizations: "1",
        dsc_token: "synthetic-dsc-secret",
      },
    },
    {
      path: "/api/new_filter/new_filter/get_fields",
      referer: `https://www.tapd.cn/tapd_fe/${workspaceId}/bug/list?useScene=bugList`,
      body: {
        workspace_id: workspaceId,
        selected_workspace_ids: [workspaceId],
        entity_types: ["bug"],
        use_scene: "bug_list",
        with_options: 0,
        is_workitem_type_menu: false,
        menu_workitem_type_id: "",
        program_id: "",
        app_id: "1",
        block_organizations: "1",
        dsc_token: "synthetic-dsc-secret",
      },
    },
  ]);
});

test("discovers Story work-item types from a verified detail when field metadata omits them", async () => {
  const storyTypeId = "1156450277001000082";
  const client = clientWith(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname === "/api/new_filter/new_filter/get_fields") {
      return response({ fields: { story: [{ field: "name", label: "标题", html_type: "text", required: true, editable: true }] } });
    }
    if (url.pathname === "/api/aggregation/story_aggregation/get_stories_list") return response({ items: [story()] });
    if (url.pathname === "/api/entity/stories/get_info") {
      assert.equal(url.searchParams.get("story_id"), story().id);
      return response(story(undefined, { all_workitem_types: { [storyTypeId]: { id: storyTypeId, name: "需求", is_default: true } } }));
    }
    throw new Error(`Unexpected TAPD request: ${url.pathname} ${String(init?.method)}`);
  });
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession(workspaceId, "story", { confId: "" });

  const result = await new StoryService(client, contexts).getFields({ workspaceId });

  assert.deepEqual(result.workItemTypes, [{ id: storyTypeId, name: "需求", isDefault: true }]);
  assert.equal(contexts.resolveStoryTypeId(workspaceId), storyTypeId);
});

test("expands short Story and Bug IDs before detail requests and preserves full IDs", async () => {
  const calls: Array<{ path: string; id: string | null; workspaceId: string | null }> = [];
  const client = clientWith(async (input) => {
    const url = new URL(input.toString());
    const isStory = url.pathname.includes("stories");
    calls.push({
      path: url.pathname,
      id: url.searchParams.get(isStory ? "story_id" : "id"),
      workspaceId: url.searchParams.get("workspace_id"),
    });
    return isStory ? response(story()) : response(bug());
  });
  const contexts = new WorkspaceContextService();
  const stories = new StoryService(client, contexts);
  const bugs = new BugService(client, contexts);

  await stories.get({ workspaceId, id: "1000001" });
  await bugs.get({ workspaceId, id: "1000002" });
  await stories.get({ workspaceId, id: story().id });
  await bugs.get({ workspaceId, id: bug().id });

  assert.deepEqual(calls, [
    { path: "/api/entity/stories/get_info", id: story().id, workspaceId },
    { path: "/api/entity/bugs/get_info", id: bug().id, workspaceId },
    { path: "/api/entity/stories/get_info", id: story().id, workspaceId },
    { path: "/api/entity/bugs/get_info", id: bug().id, workspaceId },
  ]);
});

test("confirms a minimal Story create receipt before sending its Markdown source and safe HTML", async () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    const method = String(init?.method);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, body });
    if (path.endsWith("/quickly_create")) {
      return response({ id: story().id, short_id: "1000001", name: "Story title" });
    }
    if (method === "GET") return response(story());
    return response(story(undefined, { description: body?.description, markdown_description: body?.value }));
  });
  const contexts = new WorkspaceContextService();
  contexts.hydrateFromSession(workspaceId, "story", { confId: "101", workitemTypeId: "201" });
  const service = new StoryService(client, contexts);

  const result = await service.create({
    workspaceId,
    title: "Story title",
    description: "## Details\n\n<script>alert(1)</script> & done",
  });
  assert.equal(result.partial, false);
  assert.deepEqual(result.appliedFields, ["name", "description"]);
  assert.equal(calls[0].path, "/api/entity/stories/quickly_create");
  assert.equal((calls[0].body?.Story as Record<string, unknown>).workitemTypeId, "201");
  assert.equal(calls[1].path, "/api/entity/stories/get_info");
  assert.equal(calls[2].path, "/api/entity/inline_edit/story_update");
  assert.equal(calls[2].body?.field, "markdown_description");
  assert.equal(calls[2].body?.value, "## Details\n\n<script>alert(1)</script> & done");
  assert.equal(
    calls[2].body?.description,
    '<div data-inline-code-theme="red" data-code-block-theme="default"><h2>Details</h2><p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; done</p></div>',
  );
  assert.equal(calls.filter((call) => call.path.endsWith("/quickly_create")).length, 1);
});

test("creates every Bug with the mandatory standardized Markdown template", async () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    const method = String(init?.method);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, body });
    if (path.endsWith("/create")) {
      return response({ id: bug().id, short_id: "1000002", name: "Bug title" });
    }
    if (method === "GET") return response(bug());
    const data = body?.data as Record<string, unknown>;
    return response(bug(undefined, { description: data.description, markdown_description: data.value }));
  });

  const result = await new BugService(client, new WorkspaceContextService()).create({
    workspaceId,
    title: "Bug title",
    singleIssueConfirmed: true,
    description: "点击保存后页面没有响应",
  });

  assert.equal(result.partial, false);
  assert.equal(result.workItem.id, bug().id);
  assert.deepEqual(result.appliedFields, ["name", "description"]);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/entity/bugs/create",
    "/api/entity/bugs/get_info",
    "/api/entity/bugs/inline_update",
  ]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
  const data = calls[2].body?.data as Record<string, unknown>;
  assert.equal(data.field, "markdown_description");
  assert.match(String(data.value), /^## 复现步骤/);
  assert.equal(String(data.value).includes("## 基础环境"), false);
  assert.equal(String(data.value).includes("## 待补充信息"), false);
  assert.match(String(data.value), /## 预期结果\n\n【待补充】/);
  assert.match(String(data.value), /## 实际结果\n\n点击保存后页面没有响应/);
  assert.match(String(data.value), /## 附件证据\n\n【待补充截图证据】/);
  assert.equal(String(data.description).includes("<h2>基础环境</h2>"), false);
  assert.equal(result.submittedMarkdown, data.value);
});

test("persists a requested Bug owner with TAPD's current_owner inline field after creation", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body });
    if (path.endsWith("/create")) return response({ id: bug().id, short_id: "1000002", name: "Bug title" });
    if (init?.method === "GET") return response(bug());
    return response(bug());
  });
  const contexts = new WorkspaceContextService();
  contexts.setFieldConfiguration({
    workspaceId,
    entityType: "bug",
    fields: [{ name: "owner", label: "处理人", htmlType: "member", required: false, editable: true }],
    workItemTypes: [],
  });

  const result = await new BugService(client, contexts).create({
    workspaceId,
    title: "Bug title",
    singleIssueConfirmed: true,
    description: "点击保存后页面没有响应",
    owner: "刘春林",
  });

  assert.deepEqual(result.appliedFields, ["name", "owner", "description"]);
  assert.equal(((calls[0].body?.data as Record<string, unknown>).Bug as Record<string, unknown>).owner, "刘春林");
  const ownerWrite = calls[2].body?.data as Record<string, unknown>;
  assert.deepEqual(ownerWrite, { id: bug().id, field: "current_owner", value: "刘春林" });
  assert.equal((calls[3].body?.data as Record<string, unknown>).field, "markdown_description");
});

test("treats missing or ambiguous direct Story receipt ids as an unknown create outcome", async (t) => {
  const otherId = "1156450277001000999";
  const cases: Array<{ name: string; payload: Record<string, unknown> }> = [
    {
      name: "missing id",
      payload: {
        data: { short_id: "1000001", name: "Story title" },
        meta: { code: "0", message: "success" },
      },
    },
    {
      name: "multiple direct ids",
      payload: {
        data: { id: story().id, short_id: "1000001", name: "Story title" },
        Story: { id: otherId },
        meta: { code: "0", message: "success" },
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls: Array<{ method: string; path: string }> = [];
      const client = clientWith(async (input, init) => {
        calls.push({ method: String(init?.method), path: new URL(input.toString()).pathname });
        return new Response(JSON.stringify(scenario.payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const contexts = new WorkspaceContextService();
      contexts.hydrateFromSession(workspaceId, "story", { workitemTypeId: "201" });

      await assert.rejects(
        () => new StoryService(client, contexts).create({ workspaceId, title: "Story title" }),
        (error: unknown) => error instanceof WriteOutcomeUnknownError
          && error.code === "WRITE_OUTCOME_UNKNOWN"
          && error.details.endpoint === "stories.quickly_create",
      );
      assert.deepEqual(calls, [{ method: "POST", path: "/api/entity/stories/quickly_create" }]);
    });
  }
});

test("does not issue a supplemental Story write when confirmation identity mismatches", async (t) => {
  const cases = [
    { name: "title", returned: story(undefined, { name: "Different title" }) },
    { name: "workspace", returned: story(undefined, { workspace_id: "56450278" }) },
    { name: "entity type", returned: story(undefined, { entity_type: "bug" }) },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls: Array<{ method: string; path: string }> = [];
      const client = clientWith(async (input, init) => {
        const method = String(init?.method);
        const path = new URL(input.toString()).pathname;
        calls.push({ method, path });
        if (method === "POST") return response({ id: story().id, short_id: "1000001", name: "Story title" });
        return response(scenario.returned);
      });
      const contexts = new WorkspaceContextService();
      contexts.hydrateFromSession(workspaceId, "story", { workitemTypeId: "201" });

      await assert.rejects(
        () => new StoryService(client, contexts).create({
          workspaceId,
          title: "Story title",
          description: "must not be written",
        }),
        (error: unknown) => error instanceof WriteOutcomeUnknownError
          && error.details.endpoint === "stories.quickly_create",
      );
      assert.deepEqual(calls.map((call) => call.path), [
        "/api/entity/stories/quickly_create",
        "/api/entity/stories/get_info",
      ]);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    });
  }
});

test("does not issue a supplemental Bug write when confirmation identity mismatches", async (t) => {
  const cases = [
    { name: "title", returned: bug(undefined, { title: "Different title" }) },
    { name: "workspace", returned: bug(undefined, { workspace_id: "56450278" }) },
    { name: "entity type", returned: bug(undefined, { entity_type: "story" }) },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls: Array<{ method: string; path: string }> = [];
      const client = clientWith(async (input, init) => {
        const method = String(init?.method);
        const path = new URL(input.toString()).pathname;
        calls.push({ method, path });
        if (method === "POST") return response({ id: bug().id, short_id: "1000002", name: "Bug title" });
        return response(scenario.returned);
      });

      await assert.rejects(
        () => new BugService(client, new WorkspaceContextService()).create({
          workspaceId,
          title: "Bug title",
          singleIssueConfirmed: true,
          description: "must not be written",
        }),
        (error: unknown) => error instanceof WriteOutcomeUnknownError
          && error.details.endpoint === "bugs.create",
      );
      assert.deepEqual(calls.map((call) => call.path), [
        "/api/entity/bugs/create",
        "/api/entity/bugs/get_info",
      ]);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    });
  }
});

test("maps a create confirmation GET network failure to the create endpoint's unknown outcome", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const client = clientWith(async (input, init) => {
    const method = String(init?.method);
    const path = new URL(input.toString()).pathname;
    calls.push({ method, path });
    if (method === "POST") return response({ id: bug().id, short_id: "1000002", title: "Bug title" });
    throw new TypeError("synthetic network failure");
  });

  await assert.rejects(
    () => new BugService(client, new WorkspaceContextService()).create({
      workspaceId,
      title: "Bug title",
      singleIssueConfirmed: true,
      description: "must not be written",
    }),
    (error: unknown) => error instanceof WriteOutcomeUnknownError
      && error.code === "WRITE_OUTCOME_UNKNOWN"
      && error.details.endpoint === "bugs.create",
  );
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/entity/bugs/create",
    "/api/entity/bugs/get_info",
  ]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("reports partial multi-field updates and an unknown field outcome without retrying", async () => {
  const calls: string[] = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    calls.push(path);
    if (init?.method === "GET") return response(story());
    const body = JSON.parse(String(init?.body));
    if (body.field === "name") return response(story(undefined, { name: body.value }));
    return new Response("upstream unavailable", { status: 503 });
  });
  const contexts = new WorkspaceContextService();
  const service = new StoryService(client, contexts);

  const result = await service.updateFields({
    workspaceId,
    id: "1000001",
    fields: { name: "Renamed", description: "Description" },
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.appliedFields, ["name"]);
  assert.equal(result.failedField, "description");
  assert.equal(result.outcomeUnknownField, "description");
  assert.equal(result.failure?.code, "WRITE_OUTCOME_UNKNOWN");
  assert.equal(calls.filter((path) => path.endsWith("story_update")).length, 2);
});

test("preflights and deletes Story/Bug records only with explicit confirmation", async () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    calls.push({ method: String(init?.method), path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "GET") return path.includes("stories") ? response(story()) : response(bug());
    return response({ result: "1", recovery_key: "synthetic-recovery-secret" });
  });
  const contexts = new WorkspaceContextService();
  const stories = new StoryService(client, contexts);
  const bugs = new BugService(client, contexts);

  await assert.rejects(() => stories.delete({ workspaceId, id: "1000001", confirm: false }), /confirm=true/);
  assert.equal(calls.length, 0);
  const storyResult = await stories.delete({ workspaceId, id: "1000001", confirm: true });
  const bugResult = await bugs.delete({ workspaceId, id: "1000002", confirm: true });
  assert.equal(storyResult.deleted, true);
  assert.equal(bugResult.deleted, true);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/entity/stories/get_info",
    "/api/entity/stories/delete",
    "/api/entity/bugs/get_info",
    "/api/entity/bugs/batch_delete",
  ]);
  assert.deepEqual(calls[1].body?.id, ["1156450277001000001"]);
  assert.deepEqual(calls[3].body?.data, ["1156450277001000002"]);
  assert.equal("recovery_key" in storyResult, false);
});

function bugTransitions(targets: readonly string[]): Record<string, unknown> {
  const aliases: Record<string, string> = {
    new: "新",
    in_progress: "处理中",
    resolved: "已解决",
    rejected: "已拒绝",
  };
  return {
    current_status: "new",
    status_alias: aliases,
    my_all_transitions: Object.fromEntries(targets.map((target) => [
      `STATUS_new-${target}`,
      {
        source_status: "new",
        destination_status: target,
        transition_name: aliases[target] ?? target,
        Appendfield: {
          remarks: { field: "remarks", required: false },
          current_owner: { field: "current_owner", required: false },
        },
      },
    ])),
  };
}

test("does not write when more than one normal next workflow step is available", async () => {
  let writes = 0;
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    if (init?.method === "POST") writes += 1;
    if (path.endsWith("bugs/get_info")) return response(bug());
    return response(bugTransitions(["new", "in_progress", "resolved", "rejected"]));
  });
  const workflow = new WorkflowService(client);

  const result = await workflow.advanceToNextStep({ workspaceId, entityType: "bug", id: "1000002" });
  assert.equal("requiresChoice" in result && result.requiresChoice, true);
  if ("requiresChoice" in result) {
    assert.deepEqual(result.candidates.map((candidate) => candidate.toStatus).sort(), ["in_progress", "resolved"]);
  }
  assert.equal(writes, 0);
});

test("advances the unique normal Bug step and safely encodes a workflow comment", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith("bugs/get_info")) return response(bug());
    if (path.endsWith("get_bug_transition_info")) return response(bugTransitions(["new", "in_progress", "rejected"]));
    return response({
      id: "1156450277001000002",
      new_status: "in_progress",
      new_status_name_cn: "处理中",
      message: "ok",
      comment: [{ id: "8", plain_text: "done <b>now</b> & verified" }],
    });
  });
  const workflow = new WorkflowService(client);

  const result = await workflow.advanceToNextStep({
    workspaceId,
    entityType: "bug",
    id: "1000002",
    comment: "done <b>now</b> & verified",
  });
  assert.equal("requiresChoice" in result, false);
  if (!("requiresChoice" in result)) assert.equal(result.status, "in_progress");
  const mutation = calls[2].body?.data as Record<string, unknown>;
  assert.equal(mutation.new_status, "in_progress");
  assert.equal(
    (mutation.Comment as Record<string, unknown>).description,
    "<p>done &lt;b&gt;now&lt;/b&gt; &amp; verified</p>",
  );
  assert.deepEqual(mutation["STATUS_new-in_progress"], {
    remarks: "<p>done &lt;b&gt;now&lt;/b&gt; &amp; verified</p>",
    current_owner: "",
  });
});

test("serializes only explicit TAPD member candidates into safe @mention HTML", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith("bugs/get_info")) return response(bug());
    if (path.endsWith("get_bug_transition_info")) return response(bugTransitions(["new"]));
    return response({
      id: "1156450277001000002",
      new_status: "new",
      comment: [{ id: "9", plain_text: "请 @lcl(刘春林) 检查 <script>" }],
    });
  });
  const workflow = new WorkflowService(client);

  await workflow.addComment({
    workspaceId,
    entityType: "bug",
    id: "1000002",
    comment: "请 @lcl(刘春林) 检查 <script>",
    mentions: [{ nick: "lcl", name: "刘春林" }],
  });

  const comment = ((calls[2].body?.data as Record<string, unknown>).Comment as Record<string, unknown>).description;
  assert.equal(
    comment,
    '<p>请 <b class="at-who" contenteditable="false" style="font-weight: normal;background-color: #ffefd3;color: #3582fb;padding: 1px 4px;border-radius: 3px;cursor: pointer;" data-userid="lcl" data-type="user">@lcl(刘春林)</b> 检查 &lt;script&gt;</p>',
  );
  await assert.rejects(
    () => workflow.addComment({
      workspaceId,
      entityType: "bug",
      id: "1000002",
      comment: "请处理",
      mentions: [{ nick: "lcl", name: "刘春林" }],
    }),
    /exact selected member marker/,
  );
});

test("searches the workspace member chooser without exposing extra profile fields", async () => {
  const calls: URL[] = [];
  const client = clientWith(async (input) => {
    calls.push(new URL(input.toString()));
    return response({
      count: 3,
      list: [
        { nick: "lcl", name: "刘春林", mobile: "must-not-be-returned" },
        { nick: "lcl", name: "刘春林" },
        { nick: "missing-name" },
      ],
    });
  });

  const result = await new MemberService(client).search({ workspaceId, keyword: "liu" });
  assert.deepEqual(result.candidates, [{ nick: "lcl", name: "刘春林", display: "lcl(刘春林)" }]);
  assert.equal(calls[0].pathname, "/api/workspace/members/get_member_list");
  assert.equal(calls[0].searchParams.get("keyword"), "liu");
  assert.equal(calls[0].searchParams.get("page_size"), "50");
});

test("adds a comment only through an allowed self-transition", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("bugs/get_info")) return response(bug());
    if (path.endsWith("get_bug_transition_info")) return response(bugTransitions(["new"]));
    return response({
      id: "1156450277001000002",
      new_status: "new",
      comment: {
        project_id: workspaceId,
        entry_type: "bug",
        entry_id: "1156450277001000002",
        description: "<p>comment</p>",
        id: "9",
      },
    });
  });
  const workflow = new WorkflowService(client);

  const result = await workflow.addComment({ workspaceId, entityType: "bug", id: "1000002", comment: "comment" });
  assert.equal(result.status, "new");
  assert.equal(result.comments[0].plainText, "comment");
  assert.equal((calls[2].body?.data as Record<string, unknown>).new_status, "new");
});

test("does not use an inbound transition as a comment self-transition", async () => {
  let writes = 0;
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    if (init?.method === "POST") writes += 1;
    if (path.endsWith("bugs/get_info")) return response(bug());
    return response({
      current_status: "new",
      status_alias: { new: "新", in_progress: "处理中" },
      my_all_transitions: {
        "STATUS_in_progress-new": {
          source_status: "in_progress",
          destination_status: "new",
          transition_name: "重新打开",
          Appendfield: {},
        },
      },
    });
  });
  const workflow = new WorkflowService(client);

  await assert.rejects(
    () => workflow.addComment({ workspaceId, entityType: "bug", id: "1000002", comment: "comment" }),
    /comment self-transition/,
  );
  assert.equal(writes, 0);
});

test("treats an unconfirmed comment record as an unknown write outcome", async () => {
  let writes = 0;
  const client = clientWith(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    if (init?.method === "POST") {
      writes += 1;
      return response({ id: "1156450277001000002", new_status: "new", comment: [{ id: "9" }] });
    }
    if (path.endsWith("bugs/get_info")) return response(bug());
    return response(bugTransitions(["new"]));
  });
  const workflow = new WorkflowService(client);

  await assert.rejects(
    () => workflow.addComment({ workspaceId, entityType: "bug", id: "1000002", comment: "comment" }),
    (error: unknown) => error instanceof WriteOutcomeUnknownError && error.code === "WRITE_OUTCOME_UNKNOWN",
  );
  assert.equal(writes, 1);
});
