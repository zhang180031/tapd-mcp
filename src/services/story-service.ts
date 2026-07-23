import {
  parseDeleteResult,
  parseFieldConfiguration,
  parseStoryWorkItemTypes,
  parseWorkItemDetail,
  parseWorkItemList,
  requireNonEmptyText,
  requireNumericId,
  type EditableValue,
  type FieldConfigurationResult,
  type WorkItemListResult,
  type WorkItemMutationResult,
  type WorkItemResult,
  type DeleteResult,
} from "../private-api/contracts.js";
import { InvalidArgumentError, WriteOutcomeUnknownError, toSafeFailure } from "../private-api/errors.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";
import { assertExactCreateConfirmation, parseStoryCreateReceipt } from "./create-receipt.js";
import { WorkItemResolver } from "./work-item-resolver.js";
import { WorkspaceContextService } from "./workspace-context-service.js";
import { toTapdMarkdownDescription } from "./markdown-description.js";
import { descriptionWithImages } from "./description-images.js";
import type { DeleteWorkItemInput, GetWorkItemInput, ListWorkItemsInput, UpdateFieldInput, UpdateFieldsInput } from "./service-types.js";

export interface CreateStoryInput {
  workspaceId: string;
  title: string;
  workItemTypeId?: string;
  owner?: string;
  priority?: string;
  categoryId?: string;
  description?: string;
  fields?: Readonly<Record<string, EditableValue>>;
  imagePaths?: readonly string[];
}

export class StoryService {
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
    const context = this.contexts.resolveListContext(workspaceId, "story", input.listContext);
    const response = await this.client.post({
      workspaceId,
      endpoint: "story_aggregation.get_stories_list",
      path: "/api/aggregation/story_aggregation/get_stories_list",
      kind: "read",
      body: storyListBody(workspaceId, page, perPage, input, context),
      parse: (payload) => parseWorkItemList(payload, "story", workspaceId),
    });
    return { entityType: "story", workspaceId, items: response.value.items, page, perPage, total: response.value.total, requestId: response.requestId };
  }

  get(input: GetWorkItemInput): Promise<WorkItemResult & { requestId?: string }> {
    return this.resolver.resolve({ ...input, entityType: "story" });
  }

  async getFields(input: { workspaceId: string }): Promise<FieldConfigurationResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const response = await this.client.post({
      workspaceId,
      endpoint: "story.new_filter.get_fields",
      path: "/api/new_filter/new_filter/get_fields",
      kind: "read",
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
      },
      parse: (payload) => parseFieldConfiguration(payload, "story", workspaceId),
    });
    const discoveredTypes = response.value.workItemTypes.length
      ? response.value.workItemTypes
      : await this.discoverWorkItemTypes(workspaceId);
    const result = { ...response.value, workItemTypes: discoveredTypes, requestId: response.requestId };
    this.contexts.setFieldConfiguration(result);
    return result;
  }

  async create(input: CreateStoryInput): Promise<WorkItemMutationResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const title = requireNonEmptyText(input.title, "title", 500);
    const workItemTypeId = this.contexts.resolveStoryTypeId(workspaceId, input.workItemTypeId);
    const supplemental: Record<string, EditableValue> = Object.fromEntries(
      Object.entries(input.fields ?? {}).map(([key, value]) => [normalizeStoryField(key), value]),
    );
    if (input.description !== undefined) supplemental.description = input.description;
    if (input.imagePaths?.length) {
      supplemental.description = await descriptionWithImages({
        client: this.client,
        workspaceId,
        markdown: typeof supplemental.description === "string" ? supplemental.description : "",
        imagePaths: input.imagePaths,
      });
    }
    if (input.owner !== undefined) this.contexts.validateEditableField(workspaceId, "story", "owner", input.owner);
    if (input.priority !== undefined) this.contexts.validateEditableField(workspaceId, "story", "priority", input.priority);
    if (input.categoryId !== undefined) this.contexts.validateEditableField(workspaceId, "story", "category_id", input.categoryId);
    this.validateFields(workspaceId, supplemental);
    const response = await this.client.post({
      workspaceId,
      endpoint: "stories.quickly_create",
      path: "/api/entity/stories/quickly_create",
      body: {
        Story: { workitemTypeId: workItemTypeId, name: title, owner: input.owner ?? "", priority: input.priority ?? "", entity_type: "story" },
        workspace_id: workspaceId,
        name: title,
        workitem_type_id: workItemTypeId,
        category_id: input.categoryId ?? "",
        useScene: "storyList",
        app_id: "",
        use_alias: 0,
      },
      parse: parseStoryCreateReceipt,
    });
    let confirmed: Awaited<ReturnType<WorkItemResolver["resolve"]>>;
    try {
      confirmed = await this.resolver.resolve({
        workspaceId,
        entityType: "story",
        id: response.value.id,
      });
      assertExactCreateConfirmation(confirmed, {
        endpoint: "stories.quickly_create",
        entityType: "story",
        id: response.value.id,
        workspaceId,
        title,
      });
    } catch {
      throw new WriteOutcomeUnknownError("stories.quickly_create", "invalid_response");
    }
    const { requestId: confirmationRequestId, ...workItem } = confirmed;
    const appliedFields = ["name"];
    if (input.owner !== undefined) appliedFields.push("owner");
    if (input.priority !== undefined) appliedFields.push("priority");
    if (input.categoryId !== undefined) appliedFields.push("category_id");
    return this.applySupplementalFields(
      workspaceId,
      workItem,
      supplemental,
      appliedFields,
      response.requestId ?? confirmationRequestId,
    );
  }

  async updateField(input: UpdateFieldInput): Promise<WorkItemMutationResult> {
    return this.updateFields({ workspaceId: input.workspaceId, id: input.id, fields: { [normalizeStoryField(input.field)]: input.value } });
  }

  async updateFields(input: UpdateFieldsInput & { imagePaths?: readonly string[] }): Promise<WorkItemMutationResult> {
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [normalizeStoryField(key), value]));
    if (!Object.keys(fields).length && !input.imagePaths?.length) {
      throw new InvalidArgumentError("fields", "At least one field or image is required.");
    }
    const current = await this.resolver.resolve({ workspaceId, entityType: "story", id: input.id });
    if (input.imagePaths?.length) {
      if (typeof fields.description !== "string" && !current.markdownDescription) {
        throw new InvalidArgumentError(
          "fields.description",
          "This existing Story has no Markdown source. Provide the complete Markdown in fields.description when adding images to avoid overwriting its legacy rich-text description.",
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
    if (input.confirm !== true) throw new InvalidArgumentError("confirm", "Deleting a Story requires confirm=true.");
    const workspaceId = this.contexts.requireWorkspaceId(input.workspaceId);
    const item = await this.resolver.resolve({ workspaceId, entityType: "story", id: input.id });
    const response = await this.client.post({
      workspaceId,
      endpoint: "stories.delete",
      path: "/api/entity/stories/delete?from=undefined",
      body: { workspaceId, workspace_id: workspaceId, id: [item.id] },
      parse: (payload) => parseDeleteResult(payload, "story", workspaceId, item.id),
    });
    return { ...response.value, requestId: response.requestId };
  }

  private validateFields(workspaceId: string, fields: Readonly<Record<string, EditableValue>>): void {
    for (const [field, value] of Object.entries(fields)) {
      if (field !== "name" && field !== "description") {
        throw new InvalidArgumentError(
          "fields",
          `Story inline field ${field} is not enabled in v1. Only name and description have a verified private-API wire contract; use workflow tools for status.`,
        );
      }
      this.contexts.validateEditableField(workspaceId, "story", field, value);
    }
  }

  private async discoverWorkItemTypes(workspaceId: string): Promise<FieldConfigurationResult["workItemTypes"]> {
    try {
      const list = await this.list({ workspaceId, page: 1, perPage: 1, filters: {} });
      const first = list.items[0];
      if (!first) return [];
      const response = await this.client.get({
        workspaceId,
        endpoint: "stories.get_info.type_catalog",
        path: "/api/entity/stories/get_info",
        query: { story_id: first.id, workspace_id: workspaceId, enable_description: true, is_detail: 1 },
        parse: parseStoryWorkItemTypes,
      });
      return response.value;
    } catch {
      // Field metadata remains useful even when this optional type enrichment
      // is unavailable (for example, an empty workspace).
      return [];
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
          endpoint: "inline_edit.story_update",
          path: "/api/entity/inline_edit/story_update",
          body: markdown
            ? {
                id: workItem.id,
                workspace_id: workspaceId,
                field: "markdown_description",
                value: markdown.markdown,
                description: markdown.html,
              }
            : { id: workItem.id, workspace_id: workspaceId, field, value },
          parse: (payload) => parseWorkItemDetail(payload, "story", workspaceId, workItem.id),
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

function storyListBody(
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
    category_id: input.filters?.category_id ?? "",
    location: context.location,
    target: context.target,
    entity_types: ["story"],
    use_scene: "storyList",
    list_type: "tree",
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

function normalizeStoryField(field: string): string {
  if (field === "title") return "name";
  if (field === "markdown_description") return "description";
  return field;
}
