import type { EditableValue, EntityType, FieldConfigurationResult, FieldDefinition, WorkItemTypeOption } from "../private-api/contracts.js";
import { InvalidArgumentError, TapdPrivateError } from "../private-api/errors.js";
import { requireNumericId } from "../private-api/contracts.js";

export interface ListContextInput {
  confId?: string;
  queryToken?: string;
  identifier?: string;
  location?: string;
  target?: string;
}

export interface ResolvedListContext {
  confId: string;
  queryToken?: string;
  identifier?: string;
  location?: string;
  target?: string;
}

export interface CapturedWorkspaceContext {
  confId?: string;
  queryToken?: string;
  workitemTypeId?: string;
}

interface EntityWorkspaceContext {
  list?: ListContextInput;
  fields: Map<string, FieldDefinition>;
  workItemTypes: Map<string, WorkItemTypeOption>;
}

interface WorkspaceContext {
  story: EntityWorkspaceContext;
  bug: EntityWorkspaceContext;
}

export class MissingWorkspaceContextError extends TapdPrivateError {
  override readonly name: string = "MissingWorkspaceContextError";

  constructor(workspaceId: string, entityType: EntityType, missing: string) {
    super(
      "WORKSPACE_CONTEXT_REQUIRED",
      `TAPD workspace context is missing ${missing}; refresh or initialise this workspace before retrying.`,
      { workspaceId, entityType, missing },
    );
  }
}

/** Workspace-scoped, in-memory metadata. It deliberately has no default or allowlist. */
export class WorkspaceContextService {
  private readonly contexts = new Map<string, WorkspaceContext>();

  requireWorkspaceId(workspaceId: string): string {
    return requireNumericId(workspaceId, "workspace_id");
  }

  setListContext(workspaceId: string, entityType: EntityType, input: ListContextInput): void {
    const id = this.requireWorkspaceId(workspaceId);
    const entity = this.entityContext(id, entityType);
    const confId = input.confId === undefined ? entity.list?.confId : requireNumericId(input.confId, "conf_id");
    entity.list = {
      ...entity.list,
      ...input,
      confId,
      queryToken: input.queryToken === undefined ? entity.list?.queryToken : input.queryToken,
    };
  }

  /** Copies only workspace-scoped discovery hints from a freshly captured session. */
  hydrateFromSession(workspaceId: string, entityType: EntityType, captured: CapturedWorkspaceContext): void {
    const id = this.requireWorkspaceId(workspaceId);
    if (captured.confId !== undefined || captured.queryToken !== undefined) {
      const entity = this.entityContext(id, entityType);
      entity.list = {
        ...entity.list,
        ...(captured.confId === undefined ? {} : { confId: normalizeCapturedConfId(captured.confId) }),
        ...(captured.queryToken === undefined ? {} : { queryToken: captured.queryToken.trim() }),
      };
    }
    if (captured.workitemTypeId) {
      const typeId = requireNumericId(captured.workitemTypeId, "workitem_type_id");
      this.entityContext(id, "story").workItemTypes.set(typeId, { id: typeId, name: typeId, isDefault: true });
    }
  }

  resolveListContext(workspaceId: string, entityType: EntityType, supplied?: ListContextInput): ResolvedListContext {
    const id = this.requireWorkspaceId(workspaceId);
    if (supplied) this.setListContext(id, entityType, supplied);
    const list = this.entityContext(id, entityType).list;
    if (list?.confId === undefined) throw new MissingWorkspaceContextError(id, entityType, "conf_id");
    return { ...list, confId: list.confId };
  }

  setFieldConfiguration(configuration: FieldConfigurationResult): void {
    const workspaceId = this.requireWorkspaceId(configuration.workspaceId);
    const entity = this.entityContext(workspaceId, configuration.entityType);
    if (configuration.fields.length) {
      entity.fields = new Map(configuration.fields.map((field) => [field.name, freezeField(field)]));
    }
    if (configuration.workItemTypes.length) {
      entity.workItemTypes = new Map(configuration.workItemTypes.map((type) => [type.id, { ...type }]));
    }
  }

  resolveStoryTypeId(workspaceId: string, requested?: string): string {
    const id = this.requireWorkspaceId(workspaceId);
    const types = [...this.entityContext(id, "story").workItemTypes.values()];
    if (requested) {
      const normalized = requireNumericId(requested, "workitem_type_id");
      if (types.length > 0 && !types.some((item) => item.id === normalized)) {
        throw new InvalidArgumentError("workitem_type_id", "workitem_type_id is not present in this workspace's discovered Story types.");
      }
      return normalized;
    }
    const defaults = types.filter((item) => item.isDefault);
    if (defaults.length === 1) return defaults[0].id;
    if (types.length === 1) return types[0].id;
    throw new MissingWorkspaceContextError(id, "story", types.length ? "an explicit workitem_type_id" : "Story work-item types");
  }

  validateEditableField(workspaceId: string, entityType: EntityType, fieldName: string, value: EditableValue): void {
    const id = this.requireWorkspaceId(workspaceId);
    if (fieldName === "name") {
      if (typeof value !== "string" || !value.trim() || value.length > 500) {
        throw new InvalidArgumentError("fields", "The title field must be a non-empty string of at most 500 characters.");
      }
      return;
    }
    if (fieldName === "description") {
      if (typeof value !== "string" || value.length > 200_000) {
        throw new InvalidArgumentError("fields", "The description field must be a string of at most 200000 characters.");
      }
      return;
    }
    const field = this.entityContext(id, entityType).fields.get(fieldName);
    if (!field) throw new MissingWorkspaceContextError(id, entityType, `metadata for field ${fieldName}`);
    if (!field.editable) throw new InvalidArgumentError("fields", `Field ${fieldName} is not editable.`);
    if (field.options?.length && value !== null) {
      const candidate = String(value);
      if (!field.options.some((option) => option.value === candidate)) {
        throw new InvalidArgumentError("fields", `Value for ${fieldName} is not one of the workspace options.`);
      }
    }
  }

  getPublicSummary(workspaceId: string): {
    workspaceId: string;
    story: { hasListContext: boolean; fieldCount: number; workItemTypes: WorkItemTypeOption[] };
    bug: { hasListContext: boolean; fieldCount: number };
  } {
    const id = this.requireWorkspaceId(workspaceId);
    const context = this.entityContext(id, "story");
    const bug = this.entityContext(id, "bug");
    return {
      workspaceId: id,
      story: { hasListContext: context.list?.confId !== undefined, fieldCount: context.fields.size, workItemTypes: [...context.workItemTypes.values()] },
      bug: { hasListContext: bug.list?.confId !== undefined, fieldCount: bug.fields.size },
    };
  }

  clear(workspaceId: string): void {
    this.contexts.delete(this.requireWorkspaceId(workspaceId));
  }

  clearAll(): void {
    this.contexts.clear();
  }

  private entityContext(workspaceId: string, entityType: EntityType): EntityWorkspaceContext {
    let context = this.contexts.get(workspaceId);
    if (!context) {
      context = {
        story: { fields: new Map(), workItemTypes: new Map() },
        bug: { fields: new Map(), workItemTypes: new Map() },
      };
      this.contexts.set(workspaceId, context);
    }
    return context[entityType];
  }
}

function freezeField(field: FieldDefinition): FieldDefinition {
  return { ...field, options: field.options?.map((option) => ({ ...option })) };
}

function normalizeCapturedConfId(value: string): string {
  const normalized = value.trim();
  return normalized === "" ? "" : requireNumericId(normalized, "conf_id");
}
