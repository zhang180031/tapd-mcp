# TAPD Web API discovery

> Scope: an isolated TAPD test workspace. All workspace IDs and work-item IDs
> below are illustrative placeholders, not a runtime default or an allowlist.
>
> These are **private TAPD Web APIs**, captured from the authenticated web
> application. They are not TAPD Open API contracts and can change without
> notice. Do not call them with Open API Basic-Auth credentials.

## Security and session boundary

Every write call observed here requires the browser's current authenticated
session and a current `dsc_token` in the request body. Never write browser
cookies, `dsc_token`, recovery tokens, request URLs containing query tokens,
or raw captured responses to disk or MCP tool output.

The current session-bridge behavior is:

1. Reuse the user's existing TAPD Chrome tab through Chrome DevTools MCP.
2. Execute the private request in that page with `credentials:"include"`; the
   browser supplies Cookie and `dsc_token` internally.
3. Keep only workspace list metadata in the MCP process. No independent
   browser, Cookie database read, secret parameter, memory-pipe transfer, or
   ordinary session file is used.
4. Detect a login/session failure and return a `session_expired` error; do not
   automatically retry a write.

## Common response envelope

Most endpoints returned:

```json
{
  "data": {},
  "meta": { "code": "0", "message": "success" },
  "timestamp": "…",
  "request_id": "…"
}
```

`meta.code` was observed as either the string or number `0` on success.

## Reads

| Capability | Endpoint | Required/observed inputs | Response core |
| --- | --- | --- | --- |
| Requirement list | `POST /api/aggregation/story_aggregation/get_stories_list` | `workspace_id`, `conf_id`, `page`, `perpage`, `sort_name`, `order`, `query_token`, `entity_types:["story"]`, `use_scene:"storyList"`, `list_type:"tree"`, `dsc_token` | paged requirement list |
| Requirement field metadata | `POST /api/new_filter/new_filter/get_fields` | workspace/type field-discovery body below, `entity_types:["story"]`, `use_scene:"story_list"`, `dsc_token` | fields under `data.fields.story`; requirement types under `data.meta.workitem_type_map` |
| Bug list | `POST /api/aggregation/bug_aggregation/get_bugs_list` | `workspace_id`, `conf_id`, `page`, `perpage`, `sort_name`, `order`, `query_token`, `entity_types:["bug"]`, `use_scene:"bug_list"`, `dsc_token` | paged Bug list |
| Bug field metadata | `POST /api/new_filter/new_filter/get_fields` | workspace/type field-discovery body below, `entity_types:["bug"]`, `use_scene:"bug_list"`, `dsc_token` | fields under `data.fields.bug` |
| Work-item detail | `POST /api/aggregation/workitem_aggregation/get_info` | `workspace_id`, `entity_id`, `entity_type`, `enable_description:true`, `is_detail:1`, `blacklist_fields`, `identifier`, `installed_app_entity`, `dsc_token` | `data.get_workitem_basic_info_ret.data`: `id`, `name`, `description`, `markdown_description`, `status`, `workitem_type_id`, etc. |
| Basic item data | `POST /api/entity/workitems/get_workitem_basic_info` | `workspace_id`, `id`, `entity_type`, `dsc_token` | current item fields |
| Requirement detail | `GET /api/entity/stories/get_info` | `story_id`, `workspace_id`, `enable_description=true`, `is_detail=1` | requirement entity |
| Bug detail | `GET /api/entity/bugs/get_info` | `id`, `workspace_id`, `enable_description=true`, `is_detail=1` | Bug entity |
| Requirement workflow | `GET /api/aggregation/story_aggregation/get_story_transition_info` | `workspace_id`, `story_id`, `field_blocker` | current status, aliases, allowed transitions and `Appendfield` requirements |
| Bug workflow | `GET /api/aggregation/bug_aggregation/get_bug_transition_info` | `workspace_id`, `bug_id`, `program_id`, `has_rule_fields`, `check_rule_fields` | current status, aliases, allowed transitions and transition fields |

The 2026-07-21 Bug detail response places the primary entity at `data.Bug`.
Its workspace is `project_id`; Markdown-enabled records include both
`description` and `markdown_description`. The observed `sid` is not the public
short Bug id. For a short-id lookup, the parser verifies the deterministic TAPD
encoding `11 + workspace_id + short_id.padStart(9, "0")` against the returned
full id, then derives the public short id from that same encoding. It still
requires the exact requested identity and explicit workspace match.
| Generic workflow conditions | `GET /api/entity/workflow/get_workflow_condition_map` | `workspace_id`, `entity_id`, `entity_type` | field validation/configuration |

### Story/Bug field metadata — verified new-filter contract

Field metadata does not use list `conf_id` or `query_token`. Both entity types
call the same endpoint with an entity-specific `entity_types` and `use_scene`:

`POST /api/new_filter/new_filter/get_fields`

```json
{
  "workspace_id": "<workspace-id>",
  "selected_workspace_ids": ["<workspace-id>"],
  "entity_types": ["story"],
  "use_scene": "story_list",
  "with_options": 0,
  "is_workitem_type_menu": false,
  "menu_workitem_type_id": "",
  "program_id": "",
  "app_id": "1",
  "block_organizations": "1",
  "dsc_token": "<in-memory only>"
}
```

The Bug request has the same fields, with `entity_types:["bug"]` and
`use_scene:"bug_list"`.

The Story response stores definitions at `data.fields.story` and workspace
Story types at `data.meta.workitem_type_map`. The Bug response stores
definitions at `data.fields.bug`. The MCP sends a Story-list Referer for the
Story request and a Bug-list Referer for the Bug request.

For a newly created requirement, the observed first transitions were
`status_2` (新) → `status_3` (评审中), `status_10` (挂起), and a self-transition
for comment/owner changes. For a new Bug, they were `new` (新) →
`in_progress` (接受/处理), `rejected` (已拒绝), and a self-transition.

An MCP `next_step` tool must always read the relevant workflow endpoint first
and choose from its returned transitions; status codes must not be guessed.

## Create

### Requirement — verified quick create

`POST /api/entity/stories/quickly_create`

```json
{
  "Story": {
    "workitemTypeId": "<workspace story type id>",
    "name": "Title",
    "owner": "",
    "priority": "",
    "entity_type": "story"
  },
  "workspace_id": "<workspace-id>",
  "name": "Title",
  "workitem_type_id": "<workspace story type id>",
  "category_id": "",
  "useScene": "storyList",
  "app_id": "",
  "use_alias": 0,
  "dsc_token": "<in-memory only>"
}
```

Success: `data` is a complete `Story` object. Confirmed fields include `id`,
`short_id`, `name`, `workspace_id`, `status`, `workitem_type_id`,
`category_id`, `priority`, `owner`, `description`, and `workspace_name`.

### Bug — verified quick create

`POST /api/entity/bugs/create`

```json
{
  "data": {
    "Bug": {
      "name": "Title",
      "title": "Title",
      "iteration_id": "",
      "owner": ""
    }
  },
  "use_alias": 0,
  "workspace_id": "<workspace-id>",
  "quickly_add": true,
  "dsc_token": "<in-memory only>"
}
```

Success: `data` includes `id`, `short_id`, `title`, `status:"new"`,
`workspace_id`, `entity_type:"bug"`, and `iteration_id`.

## Update

### Requirement inline update

`POST /api/entity/inline_edit/story_update`

```json
{
  "id": "<full story id>",
  "workspace_id": "<workspace-id>",
  "field": "name | markdown_description | <other editable field>",
  "value": "new value or Markdown source",
  "description": "<safe HTML rendering; required with markdown_description>",
  "dsc_token": "<in-memory only>"
}
```

Verified for `field:"name"`, legacy `field:"description"`, and on 2026-07-21
for Markdown `field:"markdown_description"`. The Markdown request sends the
source in `value` and its rendered HTML in the sibling `description` field.
Successful response is a full Story-shaped object, including the changed
field, `status_alias`, owner, priority, dates, custom fields, and
`meta.code:"0"`.

### Bug inline update

`POST /api/entity/bugs/inline_update`

```json
{
  "data": {
    "id": "<full bug id>",
    "field": "name | markdown_description | <other editable field>",
    "value": "new value or Markdown source",
    "description": "<safe HTML rendering; required with markdown_description>"
  },
  "workspace_id": "<workspace-id>",
  "dsc_token": "<in-memory only>"
}
```

Verified for `field:"name"`, legacy `field:"description"`, and on 2026-07-21
for Markdown `field:"markdown_description"`. The Markdown request sends the
source in `data.value` and the rendered HTML in `data.description`. Success has
`meta.code:"0", meta.message:"保存成功"`; `data` includes `id`, `title`,
`description`, `markdown_description`, `status`, and `workspace_id`.

For a Bug handling owner, the frontend maps logical `owner` to
`data.field:"current_owner"`. Quick-create accepts an `owner` value but did
not persist it in a live `46163983` probe; a follow-up `current_owner` inline
update did persist and was confirmed by a detail readback. The MCP therefore
uses that follow-up update before reporting `owner` as applied.

Before exposing arbitrary `field` updates in MCP, query the workspace field
configuration and validate field/value compatibility. Unverified field names
must be presented as experimental rather than guaranteed.

## Workflow transition and comment

### Requirement

`POST /api/entity/workflow/change_story_status`

```json
{
  "workspace_id": "<workspace-id>",
  "data": {
    "type": "storieslist",
    "new_status": "status_3",
    "checked_condition": 0,
    "change_type": "",
    "Story": {
      "current_status": "status_2",
      "story_id": "<full story id>",
      "close_task": false,
      "complete_effort": false
    },
    "branch": {},
    "Comment": {
      "description": "<p>optional comment</p>",
      "markdown_description": "",
      "description_type": 1,
      "comment_location": "workflow_classic_bottom",
      "npc_repo_path": ""
    },
    "is_editor_or_markdown": 1,
    "STATUS_status_2-status_3": { "remarks": "", "owner": "" }
  },
  "dsc_token": "<in-memory only>"
}
```

Success includes `status`, `status_name`, `message:"更新需求操作成功"`, and a
`comment` array when a comment was submitted. A comment-only operation is a
self-transition: use the current status for both `current_status` and
`new_status`, and use a matching `STATUS_<current>-<current>` object.

### Bug

`POST /api/entity/workflow/change_bug_status`

```json
{
  "workspace_id": "<workspace-id>",
  "data": {
    "Bug": {
      "current_status": "new",
      "id": "<full bug id>",
      "complete_effort": false
    },
    "new_status": "in_progress",
    "Comment": {
      "description": "<p>optional comment</p>",
      "markdown_description": "",
      "description_type": 1,
      "comment_location": "workflow_classic_bottom",
      "npc_repo_path": ""
    },
    "is_editor_or_markdown": 1,
    "branch": {},
    "STATUS_new-in_progress": {
      "remarks": "",
      "current_owner": "",
      "de": ""
    }
  },
  "dsc_token": "<in-memory only>"
}
```

Success includes `id`, `new_status`, `new_status_name_cn`, `owner`,
`workspace_id`, `comment`, and `message:"Bug单更新成功。"`. In the current
Bug comment-only response, `data.comment` is one object rather than the Story
array shape. Its confirmed persistence fields are a positive `id`, the work
item `entry_id`, `entry_type`, `author`, and the submitted HTML in
`description`. The MCP decodes that HTML back to normalized plain text and
requires it to match the submitted comment before reporting success.

For every transition, build the `STATUS_<from>-<to>` object from the
transition endpoint's returned `Appendfield` list. A required field must be
supplied; optional fields can be blank.

## Delete (recycle-bin delete)

### Requirement

`POST /api/entity/stories/delete?from=undefined`

```json
{
  "workspaceId": "<workspace-id>",
  "workspace_id": "<workspace-id>",
  "id": ["<full story id>"],
  "dsc_token": "<in-memory only>"
}
```

### Bug

`POST /api/entity/bugs/batch_delete?from=`

```json
{
  "workspace_id": "<workspace-id>",
  "data": ["<full bug id>"],
  "op_type": "delete",
  "dsc_token": "<in-memory only>"
}
```

Both verified responses had `meta.code:"0"` and `data.result:"1"`. They
also contain one-time recovery data; strip that data completely from logs and
MCP responses. Treat this as a destructive action and require an explicit
confirmation flag in an MCP tool.

## Mentions (`@`)

The workflow editor serializes comments as HTML in `Comment.description`.
Requirement responses can return comment arrays with `plain_text`; the
verified Bug response returns one comment object with `description`, `id`,
`author`, `entry_type`, and `entry_id`. The UI advertises `@通知他人`.

The current frontend resolves candidates with a workspace-scoped GET:

```text
/api/basic/user/user_chooser?key_word=<query>&workspace_id=<workspace>&disabled=0&show_child_user=1&per_page=50&select_type=fuzzy_match&chooser_type=userspinyin
```

The response is `data: [...]`; the editor uses each candidate's `nick` and
`name`, displays `nick(name)`, and writes `nick` to `data-userid`. A real
existing Story comment was read back as an HTML `<b class="at-who">` element
with `contenteditable="false"`, `data-userid`, and `data-type="user"`, plus
matching `plain_text`. The MCP therefore accepts only exact `nick`/`name`
pairs returned by this endpoint and emits the same constrained element shape.
It never accepts caller-provided arbitrary comment HTML.

Writing a real mention can notify a person. The test suite locks the member
lookup request, HTML serialization, escaping, and comment-response matching,
but does not send a live notification merely to test delivery.

## Recommended MCP v1 tools

- `tapd_list_work_items`, `tapd_get_work_item`
- `tapd_create_story`, `tapd_create_bug`
- `tapd_format_bug_report` (strict Markdown preview; one issue per call)
- `tapd_update_story`, `tapd_update_bug`
- `tapd_get_transitions`, `tapd_advance_to_next_step`
- `tapd_search_members` (read-only candidate lookup for @mention)
- `tapd_add_comment` (plain comment or explicit verified mentions)
- `tapd_delete_story`, `tapd_delete_bug` (explicit destructive confirmation)

`tapd_format_bug_report` and `tapd_create_bug` apply the same local Markdown
normalizer before any TAPD request. It inserts missing-data markers, rejects
generic expected/actual/step wording, treats screenshot-only input as evidence
rather than an actual result, and rejects obvious multi-problem descriptions so
the MCP caller can submit one independent Bug per call.
- `tapd_session_status`, `tapd_refresh_session` (reuse one existing Chrome TAPD tab)

Always return a minimal, sanitized result: type, full id, short id, title,
status/status label, change summary, and the TAPD request id. Never return
session cookies, `dsc_token`, query tokens, or deletion-recovery data.
