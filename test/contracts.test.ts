import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractChangedError,
  parseFieldConfiguration,
  parseTransitionList,
  parseTransitionMutation,
  parseWorkItemDetail,
  parseWorkItemList,
  toTapdFullId,
} from "../src/private-api/index.js";
import { redactSensitive } from "../src/security/index.js";

const workspaceId = "56450277";

test("work-item list parser reads the observed endpoint-specific Story and Bug containers", () => {
  const stories = parseWorkItemList({
    data: {
      stories_list: {
        data: {
          total_count: "1",
          stories_list: [{
            Story: {
              id: "1156450277001000001",
              short_id: "1000001",
              name: "Story title",
              status: "status_2",
              workspace_id: workspaceId,
              entity_type: "Story",
            },
          }],
        },
      },
    },
  }, "story", workspaceId);
  const bugs = parseWorkItemList({
    data: {
      bugs_list: {
        data: {
          total_count: 1,
          bugs_list: [{
            Bug: {
              id: "1156450277001000002",
              short_id: "1000002",
              title: "Bug title",
              status: "new",
              project_id: workspaceId,
            },
          }],
        },
      },
    },
  }, "bug", workspaceId);

  assert.deepEqual({ total: stories.total, ids: stories.items.map((item) => item.id) }, {
    total: 1,
    ids: ["1156450277001000001"],
  });
  assert.deepEqual({ total: bugs.total, ids: bugs.items.map((item) => item.id) }, {
    total: 1,
    ids: ["1156450277001000002"],
  });
});

test("work-item list parser accepts the current *_list_ret aggregation wrapper", () => {
  const bugs = parseWorkItemList({
    data: {
      bugs_list_ret: {
        data: {
          total_count: "1",
          bugs_list: [{
            Bug: {
              id: "1156450277001000002",
              short_id: "1000002",
              title: "Bug title",
              status: "new",
              workspace_id: workspaceId,
              entity_type: "Bug",
            },
          }],
        },
      },
    },
  }, "bug", workspaceId);

  assert.deepEqual({ total: bugs.total, ids: bugs.items.map((item) => item.id) }, {
    total: 1,
    ids: ["1156450277001000002"],
  });
});

test("work-item list parser accepts only confirmed empty list responses", () => {
  assert.deepEqual(
    parseWorkItemList({ data: { stories_list: { data: { stories_list: [] } } } }, "story", workspaceId),
    { items: [], total: undefined },
  );
  assert.deepEqual(
    parseWorkItemList({ data: { bugs_list: { data: { total_count: "0" } } } }, "bug", workspaceId),
    { items: [], total: 0 },
  );
  assert.deepEqual(
    parseWorkItemList({ data: { items: [] } }, "story", workspaceId),
    { items: [], total: undefined },
  );

  for (const entityType of ["story", "bug"] as const) {
    assert.throws(
      () => parseWorkItemList({ data: { unrelated: [] } }, entityType, workspaceId),
      (error: unknown) => error instanceof ContractChangedError && error.code === "CONTRACT_CHANGED",
    );
  }
});

test("detail parser fails closed unless the returned full or short ID matches", () => {
  const payload = {
    data: {
      related: {
        id: "1156450277001000999",
        short_id: "1000999",
        name: "related item",
        status: "new",
        workspace_id: workspaceId,
        entity_type: "story",
      },
      requested: {
        id: "1156450277001000001",
        short_id: "1000001",
        name: "requested item",
        status: "new",
        workspace_id: workspaceId,
        entity_type: "story",
      },
    },
  };

  assert.equal(parseWorkItemDetail(payload, "story", workspaceId, "1000001").id, "1156450277001000001");
  assert.throws(
    () => parseWorkItemDetail({ data: payload.data.related }, "story", workspaceId, "1000001"),
    ContractChangedError,
  );
  assert.throws(
    () => parseWorkItemDetail({
      data: {
        ...payload.data.related,
        short_id: "1000001",
      },
    }, "story", workspaceId, "1000001"),
    ContractChangedError,
  );
  assert.throws(
    () => parseTransitionMutation(
      { data: { id: "1", new_status: "in_progress", comment: [{}] } },
      "bug",
      workspaceId,
      "1",
      "new",
      "in_progress",
      "submitted comment",
    ),
    ContractChangedError,
  );
});

test("TAPD full-ID expansion covers the complete short-ID boundary", () => {
  assert.equal(toTapdFullId(workspaceId, "1"), `11${workspaceId}000000001`);
  assert.equal(toTapdFullId(workspaceId, "999999999"), `11${workspaceId}999999999`);
  assert.equal(
    toTapdFullId(workspaceId, "1156450277001000001"),
    "1156450277001000001",
  );
});

test("detail parser reaches an exact Bug record after a large bounded component envelope", () => {
  const id = "1156450277001001343";
  const noisyComponents: unknown[] = Array.from({ length: 450 }, (_, index) => ({
    component: `component_${index}`,
    enabled: true,
  }));
  noisyComponents.push({
    Bug: {
      id,
      short_id: "1001343",
      title: "Markdown Bug",
      status: "new",
      workspace_id: workspaceId,
      entity_type: "bug",
      markdown_description: "## 实际结果",
    },
  });

  const result = parseWorkItemDetail({ data: { components: noisyComponents } }, "bug", workspaceId, id);
  assert.equal(result.id, id);
  assert.equal(result.markdownDescription, "## 实际结果");
});

test("Bug detail parser derives the short id from the exact TAPD full-id encoding", () => {
  const fullId = "1156450277001001344";
  const shortId = "1001344";
  const result = parseWorkItemDetail({
    data: {
      Bug: {
        id: fullId,
        sid: "0",
        project_id: workspaceId,
        title: "Observed Bug envelope",
        status: "new",
      },
    },
  }, "bug", workspaceId, shortId);

  assert.equal(result.id, fullId);
  assert.equal(result.shortId, shortId);
});

test("field configuration parser rejects an empty or unrecognised success payload", () => {
  assert.throws(() => parseFieldConfiguration({}, "story", workspaceId), ContractChangedError);
  const result = parseFieldConfiguration({
    data: {
      fields: [
        { field: "name", label: "标题", html_type: "text", required: true, editable: true },
        { field: "owner", label: "处理人", html_type: "member", editable: true },
      ],
      types: [{ workitem_type_id: "201", workitem_type_name: "需求", is_default: true }],
    },
  }, "story", workspaceId);
  assert.equal(result.fields.length, 2);
  assert.equal(result.workItemTypes[0].id, "201");
});

test("field configuration parser reads the explicit new-filter work-item type map", () => {
  const typeId = "1156450277001000082";
  const result = parseFieldConfiguration({
    data: {
      fields: {
        story: [
          { field: "name", label: "标题", html_type: "text", required: true, editable: true },
        ],
      },
      meta: {
        workitem_type_map: {
          [typeId]: { id: typeId, name: "需求" },
          invalid: { id: "999", name: "must not be treated as a type" },
        },
      },
    },
  }, "story", workspaceId);

  assert.deepEqual(result.workItemTypes, [{ id: typeId, name: "需求", isDefault: false }]);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].name, "name");
});

test("Story detail type catalog parser accepts only explicit type id/name records", async () => {
  const { parseStoryWorkItemTypes } = await import("../src/private-api/contracts.js");
  const types = parseStoryWorkItemTypes({
    data: {
      Story: {
        all_workitem_types: {
          primary: { id: "1156450277001000082", name: "需求", is_default: true },
          malformed: { id: "0", name: "默认" },
        },
      },
      unrelated: { id: "1156450277001000999", name: "不应采集" },
    },
  });

  assert.deepEqual(types, [{ id: "1156450277001000082", name: "需求", isDefault: true }]);
});

test("transition parser identifies one alias-constrained transition collection without relying on its private key name", () => {
  const result = parseTransitionList({
    data: {
      get_workflow_by_story: {
        data: {
          current_status: "status_2",
          status_alias: { status_2: "New", status_3: "Review", status_10: "Paused" },
          branch: [],
          date_fields: [{ field: "begin" }],
          current_story: { id: "must-not-be-treated-as-a-transition" },
          available_actions: {
            review: {
              source_status: "status_2",
              target_status: "status_3",
              Appendfield: { remarks: { field: "remarks", Notnull: "no" } },
            },
            pause: {
              source_status: "status_2",
              target_status: "status_10",
              Appendfield: {},
            },
          },
        },
      },
    },
  }, "story", workspaceId, "1156450277001000001");

  assert.deepEqual(result.transitions.map((transition) => transition.toStatus), ["status_3", "status_10"]);
  assert.equal(result.transitions[0].fields[0].name, "remarks");

  assert.throws(
    () => parseTransitionList({
      data: {
        current_status: "status_2",
        status_alias: { status_2: "New", status_3: "Review" },
        unrelated: [{ target_status: "not_an_alias" }],
      },
    }, "story", workspaceId, "1156450277001000001"),
    ContractChangedError,
  );
});

test("transition parser reads the current StepPrevious/StepNext Story workflow contract", () => {
  const result = parseTransitionList({
    data: {
      get_workflow_by_story: {
        data: {
          current_status: "status_2",
          status_alias: { status_2: "New", status_3: "Review", status_4: "Done" },
          my_all_transitions: [
            {
              Name: "Submit review",
              StepPrevious: "status_2",
              StepNext: "status_3",
              from: { ignored: true },
              to: { ignored: true },
              Appendfield: [
                { FieldName: "remarks", FieldLabel: "Remarks", Notnull: "1", Type: "textarea", field_name: "remarks" },
              ],
            },
            {
              Name: "Complete",
              StepPrevious: "status_2",
              StepNext: "status_4",
              from: { ignored: true },
              to: { ignored: true },
              Appendfield: [],
            },
          ],
          branch: [],
          date_fields: [],
        },
      },
    },
  }, "story", workspaceId, "1156450277001000001");

  assert.deepEqual(result.transitions.map((transition) => transition.toStatus), ["status_3", "status_4"]);
  assert.deepEqual(result.transitions[0].fields, [{
    name: "remarks",
    label: "Remarks",
    required: true,
    htmlType: "textarea",
  }]);
});

test("transition mutation parser requires confirmed status and a real comment record", () => {
  assert.throws(
    () => parseTransitionMutation({}, "bug", workspaceId, "1", "new", "in_progress"),
    ContractChangedError,
  );
  assert.throws(
    () => parseTransitionMutation(
      { data: { id: "1", new_status: "in_progress" } },
      "bug",
      workspaceId,
      "1",
      "new",
      "in_progress",
      "submitted comment",
    ),
    ContractChangedError,
  );
  const result = parseTransitionMutation(
    { data: { id: "1", new_status: "in_progress", comment: [{ id: "9", plain_text: "submitted comment" }] } },
    "bug",
    workspaceId,
    "1",
    "new",
    "in_progress",
    "submitted comment",
  );
  assert.equal(result.status, "in_progress");
  assert.equal(result.comments[0].id, "9");
});

test("transition mutation parser only accepts a returned comment id with matching persisted text", () => {
  const parse = (comment: unknown) => parseTransitionMutation(
    { data: { id: "1", new_status: "in_progress", comment } },
    "bug",
    workspaceId,
    "1",
    "new",
    "in_progress",
    "submitted\ncomment",
  );

  assert.throws(() => parse([{ id: "9" }]), ContractChangedError);
  assert.throws(
    () => parse([{ id: "9", plain_text: "an older comment" }]),
    ContractChangedError,
  );
  assert.throws(
    () => parse([{ id: "0", plain_text: "submitted\ncomment" }]),
    ContractChangedError,
  );

  const result = parse([
    { id: "8", plain_text: "an older comment" },
    { id: "9", plain_text: " submitted\r\ncomment " },
  ]);
  assert.deepEqual(result.comments, [{ id: "9", plainText: "submitted\ncomment", author: undefined, createdAt: undefined }]);

  assert.throws(
    () => parse({
      project_id: workspaceId,
      entry_type: "bug",
      entry_id: "1",
      description: "<p>submitted<br>comment &amp; &lt;verified&gt;</p>",
      id: "10",
      author: "tester",
    }),
    ContractChangedError,
  );

  const htmlResult = parseTransitionMutation(
    {
      data: {
        id: "1",
        new_status: "in_progress",
        comment: {
          project_id: workspaceId,
          entry_type: "bug",
          entry_id: "1",
          description: "<p>submitted<br>comment &amp; &lt;verified&gt;</p>",
          id: "10",
          author: "tester",
        },
      },
    },
    "bug",
    workspaceId,
    "1",
    "new",
    "in_progress",
    "submitted\ncomment & <verified>",
  );
  assert.deepEqual(htmlResult.comments, [{ id: "10", plainText: "submitted\ncomment & <verified>", author: "tester", createdAt: undefined }]);
});

test("recursive output redaction strips secret and recovery fields plus inline credentials", () => {
  const redacted = redactSensitive({
    cookie: "synthetic-cookie-secret",
    nested: {
      dsc_token: "synthetic-dsc-secret",
      queryToken: "synthetic-query-secret",
      recovery_key: "synthetic-recovery-secret",
      message: "authorization=synthetic-auth-secret",
      tokenMessage: "token=synthetic-token-secret socket_token=synthetic-socket-secret tapd_session=synthetic-session-secret",
    },
    safe: "kept",
  });
  const json = JSON.stringify(redacted);
  for (const secret of [
    "synthetic-cookie-secret",
    "synthetic-dsc-secret",
    "synthetic-query-secret",
    "synthetic-recovery-secret",
    "synthetic-auth-secret",
    "synthetic-token-secret",
    "synthetic-socket-secret",
    "synthetic-session-secret",
  ]) {
    assert.equal(json.includes(secret), false);
  }
  assert.match(json, /kept/);
});

test("inline redaction removes complete Cookie and Set-Cookie header values", () => {
  const redacted = redactSensitive([
    "Cookie: tapd_session=synthetic-session-secret; locale=synthetic-locale-secret; route=synthetic-route-secret\r\nnext: kept",
    "Set-Cookie: tapd_session=synthetic-rotated-secret; Path=/; Secure; HttpOnly\nnext: kept-too",
  ]) as string[];

  assert.equal(redacted[0], "Cookie: [REDACTED]\r\nnext: kept");
  assert.equal(redacted[1], "Set-Cookie: [REDACTED]\nnext: kept-too");
  assert.equal(JSON.stringify(redacted).includes("synthetic-"), false);
});
