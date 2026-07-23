import {
  parseDeleteResult,
  parseFieldConfiguration,
  parseWorkItemDetail,
  parseWorkItemList,
  requireNonEmptyText,
  type DeleteResult,
  type EditableValue,
  type FieldConfigurationResult,
  type WorkItemListResult,
  type WorkItemMutationResult,
  type WorkItemResult,
} from "../private-api/contracts.js";
import { InvalidArgumentError, WriteOutcomeUnknownError, toSafeFailure } from "../private-api/errors.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";
import type { DeleteWorkItemInput, GetWorkItemInput, ListWorkItemsInput, UpdateFieldInput, UpdateFieldsInput } from "./service-types.js";
import { assertExactCreateConfirmation, parseBugCreateReceipt } from "./create-receipt.js";
import { WorkItemResolver } from "./work-item-resolver.js";
import { WorkspaceContextService } from "./workspace-context-service.js";
import { descriptionWithImages } from "./description-images.js";
import { formatBugReport, type BugClassification } from "./bug-report-markdown.js";
import { toTapdMarkdownDescription } from "./markdown-description.js";

export interface CreateBugInput {
  workspaceId: string;
  title: string;
  singleIssueConfirmed: true;
  iterationId?: string;
  owner?: string;
  description?: string;
  expectedResult?: string;
  actualResult?: string;
  reproductionSteps?: readonly string[];
  productVersion?: string;
  device?: string;
  operatingSystem?: string;
  clientName?: string;
  account?: string;
  reproductionProbability?: string;
  attachmentEvidence?: readonly string[];
  classification?: BugClassification;
  fields?: Readonly<Record<string, EditableValue>>;
  imagePaths?: readonly string[];
}

export class BugService {
  private readonly resolver: WorkItemResolver;

  constructor(
    private readonly client: PrivateHttpClient,
    private readonly contexts: WorkspaceContextService,
    resolver?: WorkItemResolver,
  ) {
    this.resolver = resolver ?? new WorkItemResolver(client);
  }

  async list(input: ListWorkItemsInput): Promise<WorkItemListResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const page = positivePage(input.page, 1, "page");
    const perPage = positivePage(input.perPage, 50, "per_page");
    const context = this.contexts.resolveListContext(workspaceId, "bug", input.listContext);
    const response = await this.client.post({
      workspaceId,
      endpoint: "bug_aggregation.get_bugs_list",
      path: "/api/aggregation/bug_aggregation/get_bugs_list",
      kind: "read",
      body: bugListBody(workspaceId, page, perPage, input, context),
      parse: (payload) => parseWorkItemList(payload, "bug", workspaceId),
    });
    return { entityType: "bug", workspaceId, items: response.value.items, page, perPage, total: response.value.total, requestId: response.requestId };
  }

  get(input: GetWorkItemInput): Promise<WorkItemResult & { requestId?: string }> {
    return this.resolver.resolve({ ...input, entityType: "bug" });
  }

  async getFields(input: { workspaceId: string }): Promise<FieldConfigurationResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const response = await this.client.post({
      workspaceId,
      endpoint: "bug.new_filter.get_fields",
      path: "/api/new_filter/new_filter/get_fields",
      kind: "read",
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
      },
      parse: (payload) => parseFieldConfiguration(payload, "bug", workspaceId),
    });
    const result = { ...response.value, requestId: response.requestId };
    this.contexts.setFieldConfiguration(result);
    return result;
  }

  async create(input: CreateBugInput): Promise<WorkItemMutationResult> {
    if (input.singleIssueConfirmed !== true) {
      throw new InvalidArgumentError(
        "single_issue_confirmed",
        "Split unrelated problems into separate Bug calls and set single_issue_confirmed=true for each one.",
      );
    }
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const title = requireNonEmptyText(input.title, "title", 500);
    const supplemental: Record<string, EditableValue> = Object.fromEntries(
      Object.entries(input.fields ?? {}).map(([key, value]) => [normalizeBugField(key), value]),
    );
    const fieldDescription = supplemental.description;
    if (fieldDescription !== undefined && typeof fieldDescription !== "string") {
      throw new InvalidArgumentError("fields.description", "The Bug description must be Markdown or raw text.");
    }
    delete supplemental.description;
    const attachmentEvidence = [...(input.attachmentEvidence ?? [])];
    if (input.imagePaths?.length) {
      const imageMarkdown = await descriptionWithImages({
        client: this.client,
        workspaceId,
        markdown: "",
        imagePaths: input.imagePaths,
      });
      attachmentEvidence.push(...imageMarkdown.split(/\n{2,}/).filter(Boolean));
    }
    const formatted = formatBugReport({
      rawDescription: input.description ?? fieldDescription,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      productVersion: input.productVersion,
      device: input.device,
      operatingSystem: input.operatingSystem,
      client: input.clientName,
      account: input.account,
      reproductionProbability: input.reproductionProbability,
      attachmentEvidence,
      classification: input.classification,
    });
    supplemental.description = formatted.markdown;
    if (input.iterationId !== undefined) this.contexts.validateEditableField(workspaceId, "bug", "iteration_id", input.iterationId);
    if (input.owner !== undefined) this.contexts.validateEditableField(workspaceId, "bug", "owner", input.owner);
    this.validateFields(workspaceId, supplemental);
    const response = await this.client.post({
      workspaceId,
      endpoint: "bugs.create",
      path: "/api/entity/bugs/create",
      body: {
        data: { Bug: { name: title, title, iteration_id: input.iterationId ?? "", owner: input.owner ?? "" } },
        use_alias: 0,
        workspace_id: workspaceId,
        quickly_add: true,
      },
      parse: parseBugCreateReceipt,
    });
    let confirmed: Awaited<ReturnType<WorkItemResolver["resolve"]>>;
    try {
      confirmed = await this.resolver.resolve({
        workspaceId,
        entityType: "bug",
        id: response.value.id,
      });
      assertExactCreateConfirmation(confirmed, {
        endpoint: "bugs.create",
        entityType: "bug",
        id: response.value.id,
        workspaceId,
        title,
      });
    } catch {
      throw new WriteOutcomeUnknownError("bugs.create", "invalid_response");
    }
    const { requestId: confirmationRequestId, ...workItem } = confirmed;
    const appliedFields = ["name"];
    if (input.iterationId !== undefined) appliedFields.push("iteration_id");
    // TAPD accepts `owner` during quick-create but does not reliably persist
    // it. The browser uses a follow-up inline edit with `current_owner`.
    const postCreateFields: Record<string, EditableValue> = input.owner === undefined
      ? supplemental
      : { owner: input.owner, ...supplemental };
    const result = await this.applySupplementalFields(
      workspaceId,
      workItem,
      postCreateFields,
      appliedFields,
      response.requestId ?? confirmationRequestId,
    );
    return {
      ...result,
      submittedMarkdown: formatted.markdown,
      missingInformation: [...formatted.missingInformation],
      classification: formatted.classification,
    };
  }

  updateField(input: UpdateFieldInput): Promise<WorkItemMutationResult> {
    return this.updateFields({ workspaceId: input.workspaceId, id: input.id, fields: { [normalizeBugField(input.field)]: input.value } });
  }

  async updateFields(input: UpdateFieldsInput & { imagePaths?: readonly string[] }): Promise<WorkItemMutationResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [normalizeBugField(key), value]));
    if (!Object.keys(fields).length && !input.imagePaths?.length) throw new InvalidArgumentError("fields", "At least one field or image is required.");
    const current = await this.resolver.resolve({ workspaceId, entityType: "bug", id: input.id });
    if (input.imagePaths?.length) {
      if (typeof fields.description !== "string" && !current.markdownDescription) {
        throw new InvalidArgumentError(
          "fields.description",
          "This existing Bug has no Markdown source. Provide the complete Markdown in fields.description when adding images to avoid overwriting its legacy rich-text description.",
        );
      }
      fields.description = await descriptionWithImages({
        client: this.client,
        workspaceId,
        markdown: typeof fields.description === "string" ? fields.description : undefined,
        existingMarkdown: current.markdownDescription,
        imagePaths: input.imagePaths,
      });
    }
    this.validateFields(workspaceId, fields);
    return this.applySupplementalFields(workspaceId, current, fields, [], current.requestId);
  }

  async delete(input: DeleteWorkItemInput): Promise<DeleteResult> {
    if (input.confirm !== true) throw new InvalidArgumentError("confirm", "Deleting a Bug requires confirm=true.");
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const item = await this.resolver.resolve({ workspaceId, entityType: "bug", id: input.id });
    const response = await this.client.post({
      workspaceId,
      endpoint: "bugs.batch_delete",
      path: "/api/entity/bugs/batch_delete?from=",
      body: { workspace_id: workspaceId, data: [item.id], op_type: "delete" },
      parse: (payload) => parseDeleteResult(payload, "bug", workspaceId, item.id),
    });
    return { ...response.value, requestId: response.requestId };
  }

  private validateFields(workspaceId: string, fields: Readonly<Record<string, EditableValue>>): void {
    for (const [field, value] of Object.entries(fields)) {
      if (field !== "name" && field !== "description") {
        throw new InvalidArgumentError(
          "fields",
          `Bug inline field ${field} is not enabled in v1. Only name and description have a verified private-API wire contract; use workflow tools for status.`,
        );
      }
      this.contexts.validateEditableField(workspaceId, "bug", field, value);
    }
  }

  private async applySupplementalFields(
    workspaceId: string,
    initial: WorkItemResult,
    fields: Readonly<Record<string, EditableValue>>,
    initialApplied: string[],
    requestId?: string,
  ): Promise<WorkItemMutationResult> {
    let workItem = initial;
    const appliedFields = [...initialApplied];
    let latestRequestId = requestId;
    for (const [field, value] of Object.entries(fields)) {
      try {
        const markdown = field === "description" && typeof value === "string"
          ? toTapdMarkdownDescription(value)
          : undefined;
        const response = await this.client.post({
          workspaceId,
          endpoint: "bugs.inline_update",
          path: "/api/entity/bugs/inline_update",
          body: {
            data: markdown
              ? {
                  id: workItem.id,
                  field: "markdown_description",
                  value: markdown.markdown,
                  description: markdown.html,
                }
              : { id: workItem.id, field: field === "owner" ? "current_owner" : field, value },
            workspace_id: workspaceId,
          },
          parse: (payload) => parseWorkItemDetail(payload, "bug", workspaceId, workItem.id),
        });
        workItem = response.value;
        latestRequestId = response.requestId ?? latestRequestId;
        appliedFields.push(field);
      } catch (error) {
        if (appliedFields.length === 0) throw error;
        const failure = toSafeFailure(error);
        return {
          workItem,
          appliedFields,
          partial: true,
          failedField: field,
          outcomeUnknownField: failure.code === "WRITE_OUTCOME_UNKNOWN" ? field : undefined,
          failure,
          requestId: latestRequestId,
        };
      }
    }
    return { workItem, appliedFields, partial: false, requestId: latestRequestId };
  }
}

function bugListBody(
  workspaceId: string,
  page: number,
  perPage: number,
  input: Pick<ListWorkItemsInput, "sortName" | "order" | "filters">,
  context: ReturnType<WorkspaceContextService["resolveListContext"]>,
): Record<string, unknown> {
  return {
    ...safeListFilters(input.filters),
    workspace_id: workspaceId,
    conf_id: context.confId,
    sort_name: input.sortName ?? "id",
    order: input.order ?? "desc",
    perpage: perPage,
    page,
    selected_workspace_ids: [workspaceId],
    query_token: context.queryToken ?? "",
    location: context.location,
    target: context.target,
    entity_types: ["bug"],
    use_scene: "bug_list",
    identifier: context.identifier,
  };
}

function safeListFilters(
  filters: ListWorkItemsInput["filters"],
): Record<string, string | number | boolean | null | readonly (string | number | boolean)[]> {
  const output: Record<string, string | number | boolean | null | readonly (string | number | boolean)[]> = {};
  const reserved = new Set([
    "workspace_id", "workspaceId", "conf_id", "query_token", "dsc_token", "selected_workspace_ids",
    "entity_types", "use_scene", "list_type", "page", "perpage", "sort_name", "order",
  ]);
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || reserved.has(key) || /token|cookie|auth|secret|password|recover/i.test(key)) {
      throw new InvalidArgumentError("filters", `Filter ${key} is not allowed.`);
    }
    output[key] = value;
  }
  return output;
}

function positivePage(value: number | undefined, fallback: number, argument: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 500) throw new InvalidArgumentError(argument, `${argument} is out of range.`);
  return resolved;
}

function normalizeBugField(field: string): string {
  if (field === "title") return "name";
  if (field === "markdown_description") return "description";
  return field;
}
