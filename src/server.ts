import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireWorkspaceId } from "./config.js";
import { sanitizeTapdOutput } from "./security/index.js";
import type { BugClassification } from "./services/bug-report-markdown.js";
import type { TapdMention } from "./services/mentions.js";

export type EntityType = "story" | "bug";
export type RefreshAction = "begin" | "complete" | "cancel";

export const TAPD_MCP_VERSION = "0.4.0";
/** Protocol and safety rules only. Business naming and writing rules belong to
 * the optional user-authored prompt file, never to this MCP. */
export const TAPD_MCP_LOGIC_INSTRUCTIONS = [
  "Every tool call must include the explicit numeric workspace_id; never infer, cache as a default, or substitute a workspace name.",
  "Pass only facts supplied by the user or verified from TAPD. Omit unknown optional parameters; never invent values and never send placeholders such as 【待补充】 as input.",
  "For a new Bug, call tapd_create_bug directly with exactly one problem. Its description parameter is raw source material, while the server builds the final Markdown. tapd_format_bug_report is an optional read-only preview; do not feed its output back into tapd_create_bug.description.",
  "For Story and Bug image evidence, use image_paths for readable local image files. For Bugs, attachment_evidence is only for real existing Markdown image links or URLs. Omit both when no evidence was provided; the server alone decides whether a core-section marker is needed.",
  "For Story creation/update and Bug update, description is complete Markdown. An update replaces the full description rather than applying a partial patch. Use workflow tools, never fields.status, for state changes.",
  "Before an explicit transition, call tapd_get_transitions and copy the exact target status and required transition field names it returns. tapd_advance_to_next_step writes only when one unambiguous normal next step exists.",
  "For real TAPD @mentions, first use tapd_search_members in the same workspace, then pass its exact nick and name through mentions while including the matching @nick(name) marker in comment. Never invent a member or promise notification delivery without TAPD's confirmed comment result.",
  "Delete only on an explicit deletion request and pass confirm=true.",
].join("\n");

export function buildTapdMcpInstructions(userBusinessPrompt?: string): string {
  const prompt = userBusinessPrompt?.trim();
  if (!prompt) return TAPD_MCP_LOGIC_INSTRUCTIONS;
  return `${TAPD_MCP_LOGIC_INSTRUCTIONS}\n\nUser-authored business guidance:\n${prompt}`;
}

export type EditableValue = string | number | boolean | null;
export type EditableFields = Record<string, EditableValue>;
export type ListFilterValue = EditableValue | readonly (string | number | boolean)[];
export type ListFilters = Record<string, ListFilterValue>;

export interface ListWorkItemsInput {
  workspaceId: string;
  page?: number;
  perPage?: number;
  sortName?: string;
  order?: "asc" | "desc";
  filters: ListFilters;
}

export interface CreateStoryInput {
  workspaceId: string;
  name: string;
  description?: string;
  workitemTypeId?: string;
  owner?: string;
  priority?: string;
  categoryId?: string;
  fields: EditableFields;
  imagePaths?: string[];
}

export interface CreateBugInput {
  workspaceId: string;
  title: string;
  description?: string;
  expectedResult?: string;
  actualResult?: string;
  reproductionSteps?: string[];
  productVersion?: string;
  device?: string;
  operatingSystem?: string;
  clientName?: string;
  account?: string;
  reproductionProbability?: string;
  attachmentEvidence?: string[];
  classification?: BugClassification;
  singleIssueConfirmed: true;
  iterationId?: string;
  owner?: string;
  fields: EditableFields;
  imagePaths?: string[];
}

export interface FormatBugReportInput extends Omit<CreateBugInput, "title" | "iterationId" | "owner" | "fields" | "imagePaths"> {}

export interface UpdateWorkItemInput {
  workspaceId: string;
  id: string;
  fields: EditableFields;
  imagePaths?: string[];
}

export interface WorkflowInput {
  workspaceId: string;
  entityType: EntityType;
  id: string;
}

export interface DeleteWorkItemInput extends WorkflowInput {
  confirm: boolean;
}

export interface TransitionInput extends WorkflowInput {
  targetStatus: string;
  transitionFields: Record<string, string>;
  comment?: string;
  mentions?: TapdMention[];
}

export interface AdvanceInput extends WorkflowInput {
  transitionFields: Record<string, string>;
  comment?: string;
  mentions?: TapdMention[];
}

export interface TapdToolFacade {
  sessionStatus(workspaceId: string): unknown | Promise<unknown>;
  refreshSession(input: { workspaceId: string; action: RefreshAction }): unknown | Promise<unknown>;

  listStories(input: ListWorkItemsInput): Promise<unknown>;
  getStory(input: WorkflowInput): Promise<unknown>;
  getStoryFields(workspaceId: string): Promise<unknown>;
  createStory(input: CreateStoryInput): Promise<unknown>;
  updateStory(input: UpdateWorkItemInput): Promise<unknown>;
  deleteStory(input: DeleteWorkItemInput): Promise<unknown>;

  listBugs(input: ListWorkItemsInput): Promise<unknown>;
  getBug(input: WorkflowInput): Promise<unknown>;
  getBugFields(workspaceId: string): Promise<unknown>;
  searchMembers(input: { workspaceId: string; keyword: string }): Promise<unknown>;
  formatBugReport(input: FormatBugReportInput): string | Promise<string>;
  createBug(input: CreateBugInput): Promise<unknown>;
  updateBug(input: UpdateWorkItemInput): Promise<unknown>;
  deleteBug(input: DeleteWorkItemInput): Promise<unknown>;

  resolveWorkItem(input: WorkflowInput): Promise<unknown>;
  getTransitions(input: WorkflowInput): Promise<unknown>;
  transition(input: TransitionInput): Promise<unknown>;
  advance(input: AdvanceInput): Promise<unknown>;
  addComment(input: WorkflowInput & { comment: string; mentions?: TapdMention[] }): Promise<unknown>;
}

const workspaceSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "workspace_id must be a positive numeric string")
  .describe("Required numeric TAPD workspace ID from the workspace URL. Never pass a workspace name and never assume a default.");
const entityTypeSchema = z.enum(["story", "bug"])
  .describe("Work-item type: story means a requirement; bug means a defect.");
const idSchema = z.string().trim().regex(/^[1-9]\d*$/, "id must be a positive numeric string")
  .describe("Numeric TAPD short ID or full work-item ID inside workspace_id. Do not include labels such as Bug #.");
const pageSchema = z.number().int().min(1).optional()
  .describe("1-based result page. Omit for page 1.");
const perPageSchema = z.number().int().min(1).max(200).optional()
  .describe("Items per page, from 1 to 200. Omit for the server default of 50.");
const scalarValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const fieldsSchema = z.record(scalarValueSchema).default({});
const imagePathsSchema = z.array(z.string().trim().min(1).max(4096)).min(1).max(5).optional()
  .describe("Real local evidence images to upload: 1-5 readable absolute file paths, PNG/JPEG/GIF/WebP, at most 10 MiB each. Omit this parameter when the user supplied no local image; never pass a placeholder path.");
const filterValueSchema = z.union([
  scalarValueSchema,
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
const filtersSchema = z.record(filterValueSchema).default({})
  .describe("Optional TAPD filter names and values supported by this workspace. Use tapd_get_story_fields or tapd_get_bug_fields when unsure; never include workspace, session, cookie, or token fields.");
const transitionFieldsSchema = z.record(z.string().max(10_000)).default({})
  .describe("Exact transition field-name/value pairs returned by tapd_get_transitions. Pass only fields declared for the selected transition; use {} when it requires none.");
const commentSchema = z
  .string()
  .trim()
  .min(1)
  .max(10_000)
  .describe("Non-empty comment text. Plain text is escaped; use mentions only with exact candidates returned by tapd_search_members. Each selected mention must appear in this text as @nick(name).");
const mentionSchema = z.object({
  nick: z.string().trim().min(1).max(128)
    .describe("Exact TAPD member nick returned by tapd_search_members; do not guess or use a display label."),
  name: z.string().trim().min(1).max(128)
    .describe("Exact TAPD member name returned alongside nick by tapd_search_members."),
}).strict();
const mentionsSchema = z.array(mentionSchema).min(1).max(20).optional()
  .describe("Optional real TAPD @mentions. Search members in this workspace first, then include the exact @nick(name) marker for every selected member in comment. This is a write that may notify those members.");
const bugReportSchema = {
  description: z.string().trim().min(1).max(200_000).optional()
    .describe("Raw, possibly messy source text for exactly one problem. Pass the user's facts, such as a redacted curl or log excerpt, not a finished Markdown template or HTML. When structured facts are also supplied, this source is retained under supplementary material. Omit only when it adds no facts."),
  expected_result: z.string().trim().min(1).max(200_000).optional()
    .describe("Concrete correct behavior supported by a supplied product requirement, prototype, or UI design. Omit when unknown; do not invent it or pass 【待补充】."),
  actual_result: z.string().trim().min(1).max(200_000).optional()
    .describe("Objective, observable anomaly and any exact error text, clearly contrasting with expected_result. Omit when unknown; never replace missing facts with vague wording or 【待补充】."),
  reproduction_steps: z.array(z.string().trim().min(1).max(20_000)).min(1).max(20).optional()
    .describe("Known reproduction actions in execution order, one action per item, without numeric prefixes. Do not invent missing steps and do not pass 【待补充】; omit the parameter if none were supplied."),
  product_version: z.string().trim().min(1).max(20_000).optional()
    .describe("Product/build version explicitly supplied by the user. Omit when unknown; no empty value or placeholder."),
  device: z.string().trim().min(1).max(20_000).optional()
    .describe("Device or hardware model explicitly supplied by the user. Omit when unknown."),
  operating_system: z.string().trim().min(1).max(20_000).optional()
    .describe("Operating system and version explicitly supplied by the user. Omit when unknown."),
  client: z.string().trim().min(1).max(20_000).optional()
    .describe("Client or browser name and version explicitly supplied by the user. Omit when unknown."),
  account: z.string().trim().min(1).max(20_000).optional()
    .describe("Operation/test account explicitly supplied by the user. Omit when unknown; do not guess a default account."),
  reproduction_probability: z.string().trim().min(1).max(20_000).optional()
    .describe("Observed reproduction rate, for example 5/5 or 必现, only when supplied or measured. Omit when unknown."),
  attachment_evidence: z.array(z.string().trim().min(1).max(20_000)).min(1).max(20).optional()
    .describe("Real existing screenshot/recording references as Markdown image links or URLs. For local files use image_paths instead. Omit when absent; never pass 截图见附件, 【待补充】, or a fabricated URL."),
  classification: z.enum(["bug", "non_defect"]).optional()
    .describe("Defaults to bug. Use non_defect only when the desired behavior is an undefined new feature/style/interaction rather than a deviation from an existing requirement, prototype, or UI design."),
  single_issue_confirmed: z.literal(true)
    .describe("Required true only after checking that this call contains exactly one problem. Split unrelated anomalies into separate Bug calls before setting it."),
};

function explicitWorkspace(workspaceId: string): string {
  return requireWorkspaceId(workspaceId);
}

function asToolResult(data: unknown) {
  const safe = sanitizeTapdOutput(data);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: safe }, null, 2) }],
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { code: "TAPD_ERROR", message: String(error) };
  }

  const candidate = error as Error & { code?: unknown; details?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : candidate.name || "TAPD_ERROR",
    message: candidate.message,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
}

function asToolError(error: unknown) {
  const safe = sanitizeTapdOutput(errorPayload(error));
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: safe }, null, 2) }],
    isError: true,
  };
}

async function safely<T>(operation: () => T | Promise<T>) {
  try {
    return asToolResult(await operation());
  } catch (error) {
    return asToolError(error);
  }
}

async function markdownSafely(operation: () => string | Promise<string>) {
  try {
    const markdown = sanitizeTapdOutput(await operation());
    if (typeof markdown !== "string") throw new TypeError("The bug formatter did not return Markdown text.");
    return { content: [{ type: "text" as const, text: markdown }] };
  } catch (error) {
    return asToolError(error);
  }
}

function formatBugReportInput(input: {
  workspace_id: string;
  description?: string;
  expected_result?: string;
  actual_result?: string;
  reproduction_steps?: string[];
  product_version?: string;
  device?: string;
  operating_system?: string;
  client?: string;
  account?: string;
  reproduction_probability?: string;
  attachment_evidence?: string[];
  classification?: BugClassification;
  single_issue_confirmed: true;
}): FormatBugReportInput {
  return {
    workspaceId: explicitWorkspace(input.workspace_id),
    description: input.description,
    expectedResult: input.expected_result,
    actualResult: input.actual_result,
    reproductionSteps: input.reproduction_steps,
    productVersion: input.product_version,
    device: input.device,
    operatingSystem: input.operating_system,
    clientName: input.client,
    account: input.account,
    reproductionProbability: input.reproduction_probability,
    attachmentEvidence: input.attachment_evidence,
    classification: input.classification,
    singleIssueConfirmed: input.single_issue_confirmed,
  };
}

function workflowInput(input: { workspace_id: string; entity_type: EntityType; id: string }): WorkflowInput {
  return {
    workspaceId: explicitWorkspace(input.workspace_id),
    entityType: input.entity_type,
    id: input.id,
  };
}

function deleteWorkItemInput(input: {
  workspace_id: string;
  entity_type: EntityType;
  id: string;
  confirm: boolean;
}): DeleteWorkItemInput {
  return {
    ...workflowInput(input),
    confirm: input.confirm,
  };
}

function listInput(input: {
  workspace_id: string;
  page?: number;
  per_page?: number;
  sort_name?: string;
  order?: "asc" | "desc";
  filters: ListFilters;
}): ListWorkItemsInput {
  return {
    workspaceId: explicitWorkspace(input.workspace_id),
    page: input.page,
    perPage: input.per_page,
    sortName: input.sort_name,
    order: input.order,
    filters: input.filters,
  };
}

export function createTapdServer(
  facade: TapdToolFacade,
  options: { userBusinessPrompt?: string } = {},
): McpServer {
  const server = new McpServer(
    { name: "tapd-mcp", version: TAPD_MCP_VERSION },
    { instructions: buildTapdMcpInstructions(options.userBusinessPrompt) },
  );

  server.registerTool(
    "tapd_session_status",
    {
      title: "Get TAPD session status",
      description: "Check whether the selected workspace has a usable in-memory TAPD Web session. This is read-only and returns missing, waiting_for_login, valid, or expired; it never opens a browser.",
      inputSchema: { workspace_id: workspaceSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.sessionStatus(explicitWorkspace(input.workspace_id))),
  );

  server.registerTool(
    "tapd_refresh_session",
    {
      title: "Refresh the TAPD Web login session",
      description:
        "Refresh authorization through the user's existing Chrome TAPD tab and Chrome DevTools. Call begin once, ensure that same tab is logged in, then call complete for the same workspace_id. The captured TAPD-only session is saved in the configured local session store and is never returned by this tool. Use cancel to discard a pending refresh.",
      inputSchema: {
        workspace_id: workspaceSchema,
        action: z.enum(["begin", "complete", "cancel"])
          .describe("begin starts a Chrome refresh; complete validates the open TAPD page; cancel discards a pending refresh."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.refreshSession({ workspaceId: explicitWorkspace(input.workspace_id), action: input.action }),
      ),
  );

  const listSchema = {
    workspace_id: workspaceSchema,
    page: pageSchema,
    per_page: perPageSchema,
    sort_name: z.string().trim().min(1).optional()
      .describe("TAPD field name used for sorting. Omit for id."),
    order: z.enum(["asc", "desc"]).optional()
      .describe("Sort direction. Omit for desc."),
    filters: filtersSchema,
  };

  server.registerTool(
    "tapd_list_stories",
    {
      title: "List TAPD requirements",
      description: "List requirements in the explicitly selected workspace. Use filters only when their exact TAPD field names and option values are known; paginate instead of assuming the first page is complete.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.listStories(listInput(input))),
  );

  server.registerTool(
    "tapd_get_story",
    {
      title: "Get a TAPD requirement",
      description: "Resolve a numeric short or full requirement ID inside workspace_id and return the current TAPD requirement details.",
      inputSchema: { workspace_id: workspaceSchema, id: idSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.getStory(workflowInput({ ...input, entity_type: "story" }))),
  );

  server.registerTool(
    "tapd_get_story_fields",
    {
      title: "Get TAPD requirement fields",
      description: "Read requirement field definitions, legal option values, types, and workflow metadata for workspace_id. Call this before using unfamiliar create values or list filters.",
      inputSchema: { workspace_id: workspaceSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.getStoryFields(explicitWorkspace(input.workspace_id))),
  );

  server.registerTool(
    "tapd_create_story",
    {
      title: "Create a TAPD requirement",
      description: "Create one TAPD requirement. name is required; description is complete Markdown. image_paths upload and append local images to that Markdown. Pass only known optional values. If the workspace has multiple requirement types, obtain and pass workitem_type_id from tapd_get_story_fields.",
      inputSchema: {
        workspace_id: workspaceSchema,
        name: z.string().trim().min(1).max(500)
          .describe("Requirement title text. Follow the active user-authored business guidance when it is available."),
        description: z.string().trim().min(1).max(200_000).optional()
          .describe("Complete standard Markdown requirement body. The service preserves the Markdown source and sends safe HTML to TAPD. Omit when no description was supplied; do not insert empty headings or placeholders."),
        workitem_type_id: z.string().trim().regex(/^[1-9]\d*$/).optional()
          .describe("Numeric requirement type ID from tapd_get_story_fields. Omit only when the workspace has one unambiguous default type."),
        owner: z.string().trim().min(1).optional()
          .describe("Exact TAPD owner option value verified for this workspace. Omit when unknown."),
        priority: z.string().trim().min(1).optional()
          .describe("Exact TAPD priority option value verified for this workspace. Omit when unknown."),
        category_id: z.string().trim().min(1).optional()
          .describe("Exact TAPD category ID verified for this workspace. Omit when unknown."),
        fields: fieldsSchema.describe("Advanced verified inline values only. v1 accepts name and description; prefer the dedicated parameters above. Never set status here."),
        image_paths: imagePathsSchema.describe("Readable local images to append to the requirement Markdown. The service uploads them to TAPD and inserts Markdown image links; omit when no local image was supplied."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.createStory({
          workspaceId: explicitWorkspace(input.workspace_id),
          name: input.name,
          description: input.description,
          workitemTypeId: input.workitem_type_id,
          owner: input.owner,
          priority: input.priority,
          categoryId: input.category_id,
          fields: input.fields,
          imagePaths: input.image_paths,
        }),
      ),
  );

  server.registerTool(
    "tapd_update_story",
    {
      title: "Update a TAPD requirement",
      description: "Update one requirement's verified inline fields and optionally upload local images. fields.description is the complete replacement Markdown body, not a patch; image_paths append to that body or existing Markdown source. Use tapd_get_transitions plus a workflow tool for status changes.",
      inputSchema: {
        workspace_id: workspaceSchema,
        id: idSchema,
        fields: fieldsSchema.describe("Fields to replace. v1 accepts only name and description. description must contain the complete desired Markdown body. Omit fields only when image_paths should append to existing Markdown. Never pass status."),
        image_paths: imagePathsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.updateStory({
          workspaceId: explicitWorkspace(input.workspace_id),
          id: input.id,
          fields: input.fields,
          imagePaths: input.image_paths,
        }),
      ),
  );

  server.registerTool(
    "tapd_delete_story",
    {
      title: "Delete a TAPD requirement",
      description: "Resolve and move one requirement to the TAPD recycle bin. Call only when the user explicitly requested deletion; confirm must be true.",
      inputSchema: {
        workspace_id: workspaceSchema,
        id: idSchema,
        confirm: z.literal(true).describe("Required true acknowledgement that this exact requirement should be moved to the recycle bin."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (input) => safely(() => facade.deleteStory(deleteWorkItemInput({ ...input, entity_type: "story" }))),
  );

  server.registerTool(
    "tapd_list_bugs",
    {
      title: "List TAPD bugs",
      description: "List Bugs in the explicitly selected workspace. Use filters only when their exact TAPD field names and option values are known; paginate instead of assuming the first page is complete.",
      inputSchema: listSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.listBugs(listInput(input))),
  );

  server.registerTool(
    "tapd_get_bug",
    {
      title: "Get a TAPD bug",
      description: "Resolve a numeric short or full Bug ID inside workspace_id and return the current TAPD Bug details.",
      inputSchema: { workspace_id: workspaceSchema, id: idSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.getBug(workflowInput({ ...input, entity_type: "bug" }))),
  );

  server.registerTool(
    "tapd_get_bug_fields",
    {
      title: "Get TAPD bug fields",
      description: "Read Bug field definitions, legal option values, types, and workflow metadata for workspace_id. Call this before using unfamiliar owner, iteration, filter, or transition values.",
      inputSchema: { workspace_id: workspaceSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.getBugFields(explicitWorkspace(input.workspace_id))),
  );

  server.registerTool(
    "tapd_search_members",
    {
      title: "Search TAPD members for @mention",
      description: "Search members eligible for a real TAPD @mention in this exact workspace. Use a returned nick/name pair unchanged in mentions for a comment or workflow operation; this tool does not notify anyone.",
      inputSchema: {
        workspace_id: workspaceSchema,
        keyword: z.string().trim().min(1).max(100)
          .describe("Member name, nickname, or pinyin query to search within this explicit workspace."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.searchMembers({ workspaceId: explicitWorkspace(input.workspace_id), keyword: input.keyword })),
  );

  server.registerTool(
    "tapd_format_bug_report",
    {
      title: "Format one TAPD Bug as strict Markdown",
      description:
        "Preview the exact strict Markdown that tapd_create_bug would generate for one problem; this tool does not write to TAPD. Pass only known facts and omit unknown optional values. The server keeps the four core sections, retains raw source material alongside structured facts, omits absent environment fields, and rejects obvious multi-problem input. Returns Markdown only. Do not pass this output back into tapd_create_bug.description; call tapd_create_bug with the original structured inputs instead.",
      inputSchema: { workspace_id: workspaceSchema, ...bugReportSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => markdownSafely(() => facade.formatBugReport(formatBugReportInput(input))),
  );

  server.registerTool(
    "tapd_create_bug",
    {
      title: "Create a TAPD bug",
      description:
        "Create exactly one TAPD Bug and generate its final strict Markdown from raw or structured facts. Pass only information the user supplied or that was verified; omit unknown optional environment fields and never provide input placeholders. Use image_paths for local evidence files. The server preserves the four core sections, retains raw source material alongside structured facts, supplies core missing markers itself, omits absent supplementary fields, and rejects obvious multi-problem input. Use classification=non_defect for undefined new behavior. No prior tapd_format_bug_report call is required.",
      inputSchema: {
        workspace_id: workspaceSchema,
        title: z.string().trim().min(1).max(500)
          .describe("Bug title text. Follow the active user-authored business guidance when it is available."),
        ...bugReportSchema,
        iteration_id: z.string().trim().min(1).optional()
          .describe("Exact TAPD iteration option value verified for this workspace. Omit when unknown."),
        owner: z.string().trim().min(1).optional()
          .describe("Exact TAPD owner option value verified for this workspace. Omit when unknown."),
        fields: fieldsSchema.describe("Advanced verified inline values only. Prefer the dedicated Bug parameters; v1 ultimately accepts name and description, and status is forbidden. Do not place the finished formatter output in fields.description."),
        image_paths: imagePathsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.createBug({
          workspaceId: explicitWorkspace(input.workspace_id),
          title: input.title,
          description: input.description,
          expectedResult: input.expected_result,
          actualResult: input.actual_result,
          reproductionSteps: input.reproduction_steps,
          productVersion: input.product_version,
          device: input.device,
          operatingSystem: input.operating_system,
          clientName: input.client,
          account: input.account,
          reproductionProbability: input.reproduction_probability,
          attachmentEvidence: input.attachment_evidence,
          classification: input.classification,
          singleIssueConfirmed: input.single_issue_confirmed,
          iterationId: input.iteration_id,
          owner: input.owner,
          fields: input.fields,
          imagePaths: input.image_paths,
        }),
      ),
  );

  server.registerTool(
    "tapd_update_bug",
    {
      title: "Update a TAPD bug",
      description: "Update one Bug's verified inline fields and optionally upload local evidence images. fields.description is the complete replacement Markdown body, not a partial patch; image_paths append to that supplied body or the Bug's existing Markdown source. Use workflow tools for status changes.",
      inputSchema: {
        workspace_id: workspaceSchema,
        id: idSchema,
        fields: fieldsSchema.describe("Fields to replace. v1 accepts only name and description. description must be the complete desired Markdown body. Omit fields only when image_paths alone should append evidence; never pass status."),
        image_paths: imagePathsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.updateBug({
          workspaceId: explicitWorkspace(input.workspace_id),
          id: input.id,
          fields: input.fields,
          imagePaths: input.image_paths,
        }),
      ),
  );

  server.registerTool(
    "tapd_delete_bug",
    {
      title: "Delete a TAPD bug",
      description: "Resolve and move one Bug to the TAPD recycle bin. Call only when the user explicitly requested deletion; confirm must be true.",
      inputSchema: {
        workspace_id: workspaceSchema,
        id: idSchema,
        confirm: z.literal(true).describe("Required true acknowledgement that this exact Bug should be moved to the recycle bin."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (input) => safely(() => facade.deleteBug(deleteWorkItemInput({ ...input, entity_type: "bug" }))),
  );

  server.registerTool(
    "tapd_resolve_work_item_id",
    {
      title: "Resolve a TAPD work-item ID",
      description: "Resolve a numeric short or full ID within the explicit workspace and entity type. Use this when an ID is ambiguous before another operation; it performs no write.",
      inputSchema: { workspace_id: workspaceSchema, entity_type: entityTypeSchema, id: idSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.resolveWorkItem(workflowInput(input))),
  );

  server.registerTool(
    "tapd_get_transitions",
    {
      title: "Get TAPD workflow transitions",
      description: "Read the item's current status plus the exact allowed transitions and each transition's required fields. Call this immediately before tapd_transition_work_item when choosing a specific target.",
      inputSchema: { workspace_id: workspaceSchema, entity_type: entityTypeSchema, id: idSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => safely(() => facade.getTransitions(workflowInput(input))),
  );

  server.registerTool(
    "tapd_transition_work_item",
    {
      title: "Transition a TAPD work item",
      description: "Move one requirement or Bug to an explicit currently allowed target. First call tapd_get_transitions, then copy the exact target status code and supply only that transition's declared fields. This is a write and is not automatically retried.",
      inputSchema: {
        workspace_id: workspaceSchema,
        entity_type: entityTypeSchema,
        id: idSchema,
        target_status: z.string().trim().min(1)
          .describe("Exact toStatus/status code returned by tapd_get_transitions, not a guessed display label."),
        transition_fields: transitionFieldsSchema,
        comment: commentSchema.optional(),
        mentions: mentionsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.transition({
          ...workflowInput(input),
          targetStatus: input.target_status,
          transitionFields: input.transition_fields,
          comment: input.comment,
          mentions: input.mentions,
        }),
      ),
  );

  server.registerTool(
    "tapd_advance_to_next_step",
    {
      title: "Advance a TAPD work item",
      description:
        "Advance only when TAPD reports exactly one unambiguous normal forward transition. If zero or multiple candidates exist, return requiresChoice and candidates without writing; then use tapd_transition_work_item after selecting explicitly.",
      inputSchema: {
        workspace_id: workspaceSchema,
        entity_type: entityTypeSchema,
        id: idSchema,
        transition_fields: transitionFieldsSchema,
        comment: commentSchema.optional(),
        mentions: mentionsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) =>
      safely(() =>
        facade.advance({
          ...workflowInput(input),
          transitionFields: input.transition_fields,
          comment: input.comment,
          mentions: input.mentions,
        }),
      ),
  );

  server.registerTool(
    "tapd_add_comment",
    {
      title: "Add a TAPD comment",
      description: "Add one comment through TAPD's validated workflow self-transition. Plain text is escaped. To create a real @mention, first call tapd_search_members and pass its exact nick/name pair in mentions while including @nick(name) in comment; this may notify those members.",
      inputSchema: {
        workspace_id: workspaceSchema,
        entity_type: entityTypeSchema,
        id: idSchema,
        comment: commentSchema,
        mentions: mentionsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => safely(() => facade.addComment({ ...workflowInput(input), comment: input.comment, mentions: input.mentions })),
  );

  return server;
}
