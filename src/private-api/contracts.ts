import { ContractChangedError, InvalidArgumentError, TapdRequestError } from "./errors.js";

export type EntityType = "story" | "bug";
export type EditableValue = string | number | boolean | null;

export interface WorkItemResult {
  entityType: EntityType;
  id: string;
  shortId?: string;
  title: string;
  status: string;
  statusName?: string;
  workspaceId: string;
  description?: string;
  markdownDescription?: string;
}

export interface WorkItemListResult {
  entityType: EntityType;
  workspaceId: string;
  items: WorkItemResult[];
  page: number;
  perPage: number;
  total?: number;
  requestId?: string;
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDefinition {
  name: string;
  label?: string;
  htmlType?: string;
  required: boolean;
  editable: boolean;
  options?: FieldOption[];
}

export interface WorkItemTypeOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface FieldConfigurationResult {
  entityType: EntityType;
  workspaceId: string;
  fields: FieldDefinition[];
  workItemTypes: WorkItemTypeOption[];
  requestId?: string;
}

export interface TransitionField {
  name: string;
  label?: string;
  required: boolean;
  htmlType?: string;
}

export interface TransitionOption {
  fromStatus: string;
  toStatus: string;
  toStatusName?: string;
  name?: string;
  fields: TransitionField[];
}

export interface TransitionListResult {
  entityType: EntityType;
  workspaceId: string;
  id: string;
  currentStatus: string;
  currentStatusName?: string;
  statusAliases: Record<string, string>;
  transitions: TransitionOption[];
  requestId?: string;
}

export interface CommentResult {
  id: string;
  plainText: string;
  author?: string;
  createdAt?: string;
}

export interface TransitionMutationResult {
  entityType: EntityType;
  workspaceId: string;
  id: string;
  previousStatus: string;
  status: string;
  statusName?: string;
  message?: string;
  comments: CommentResult[];
  requestId?: string;
}

export interface DeleteResult {
  entityType: EntityType;
  workspaceId: string;
  id: string;
  deleted: true;
  requestId?: string;
}

export interface WorkItemMutationResult {
  workItem: WorkItemResult;
  appliedFields: string[];
  partial: boolean;
  submittedMarkdown?: string;
  missingInformation?: string[];
  classification?: "bug" | "non_defect";
  failedField?: string;
  outcomeUnknownField?: string;
  failure?: { code: string; message: string };
  requestId?: string;
}

export interface RemoteFailure {
  message: string;
  sessionExpired: boolean;
  code?: string;
}

export function requireNumericId(value: string | number, argument: string): string {
  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new InvalidArgumentError(argument, `${argument} must be a positive numeric string.`);
  }
  return normalized;
}

export function requireNonEmptyText(value: string, argument: string, maxLength = 20_000): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidArgumentError(argument, `${argument} must not be empty.`);
  if (normalized.length > maxLength) throw new InvalidArgumentError(argument, `${argument} is too long.`);
  return normalized;
}

export function extractRequestId(payload: unknown): string | undefined {
  const root = asRecord(payload);
  return readString(root, "request_id", "requestId");
}

export function inspectRemoteFailure(payload: unknown): RemoteFailure | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const meta = asRecord(root.meta);
  if (meta && "code" in meta) {
    const code = String(meta.code);
    if (code === "0") return undefined;
    const message = readString(meta, "message", "info") ?? "TAPD rejected the request.";
    return { message, code, sessionExpired: looksLikeSessionFailure(message) };
  }
  if ("status" in root && (root.status === 0 || root.status === "0" || root.status === false)) {
    const message = readString(root, "info", "message", "msg") ?? "TAPD rejected the request.";
    return { message, sessionExpired: looksLikeSessionFailure(message) };
  }
  return undefined;
}

export function parseWorkItemDetail(
  payload: unknown,
  entityType: EntityType,
  workspaceId: string,
  requestedId?: string,
): WorkItemResult {
  // Detail responses with Markdown can include large attachment/comment/component
  // collections before the basic work-item record. Keep traversal bounded, but
  // high enough to reach the exact requested id in the observed Bug envelope.
  const candidates = collectCandidateRecords(payload, 5_000);
  for (const candidate of candidates) {
    const normalized = tryNormalizeWorkItem(candidate, entityType, workspaceId);
    const expectedFullId = requestedId ? toTapdFullId(workspaceId, requestedId) : undefined;
    if (normalized && (
      !requestedId
      || normalized.id === expectedFullId
    )) return normalized;
  }
  throw new ContractChangedError(
    detailEndpoint(entityType),
    requestedId
      ? "the exact requested full id or short_id in the requested workspace and entity type"
      : "a work item with id, title, status, and workspace_id",
  );
}

export function parseWorkItemList(
  payload: unknown,
  entityType: EntityType,
  workspaceId: string,
): { items: WorkItemResult[]; total?: number } {
  const shape = findWorkItemListShape(payload, entityType);
  const items = new Map<string, WorkItemResult>();
  for (const list of shape.lists) {
    for (const entry of list) {
      for (const candidate of collectCandidateRecords(entry, 80)) {
        const normalized = tryNormalizeWorkItem(candidate, entityType, workspaceId);
        if (normalized) items.set(normalized.id, normalized);
      }
    }
  }

  const total = findAssociatedListTotal(shape.totalContainers);
  if (items.size === 0) {
    const hasNonEmptyKnownList = shape.lists.some((list) => list.length > 0);
    const hasConfirmedEmptyList = shape.lists.some((list) => list.length === 0);
    if (hasNonEmptyKnownList || (!hasConfirmedEmptyList && total !== 0)) {
      throw new ContractChangedError(listEndpoint(entityType), "an endpoint-specific work item list or an associated total of zero");
    }
  }
  return { items: [...items.values()], total };
}

interface WorkItemListShape {
  lists: unknown[][];
  totalContainers: Record<string, unknown>[];
}

/**
 * Recognise only list paths returned by the Story/Bug list endpoints. The
 * observed Web API wraps the list twice, for example
 * `data.stories_list.data.stories_list`, and currently also uses a symmetric
 * `data.bugs_list_ret.data.bugs_list` envelope. Direct `data.items` and
 * `data` arrays are retained for the other known response variants.
 */
function findWorkItemListShape(payload: unknown, entityType: EntityType): WorkItemListShape {
  const root = asRecord(payload);
  if (!root) return { lists: [], totalContainers: [] };

  const endpointKey = entityType === "story" ? "stories_list" : "bugs_list";
  const endpointEnvelopeKeys = [endpointKey, `${endpointKey}_ret`];
  const pluralKey = entityType === "story" ? "stories" : "bugs";
  const lists: unknown[][] = [];
  const totalContainers: Record<string, unknown>[] = [];
  const seenLists = new Set<unknown[]>();
  const seenContainers = new Set<Record<string, unknown>>();
  const addContainer = (value: Record<string, unknown> | undefined): void => {
    if (value && !seenContainers.has(value)) {
      seenContainers.add(value);
      totalContainers.push(value);
    }
  };
  const addList = (value: unknown, owner?: Record<string, unknown>): void => {
    if (!Array.isArray(value) || seenLists.has(value)) return;
    seenLists.add(value);
    lists.push(value);
    addContainer(owner);
  };

  const dataValue = root.data;
  const data = asRecord(dataValue);
  addList(dataValue, root);

  // A zero total at the response root or its direct data object is associated
  // with this endpoint invocation, unlike totals buried in unrelated objects.
  addContainer(root);
  addContainer(data);

  for (const container of [root, data]) {
    if (!container) continue;
    addList(container.items, container);
    addList(container[pluralKey], container);
    for (const envelopeKey of endpointEnvelopeKeys) {
      addList(container[envelopeKey], container);

      const endpointEnvelope = asRecord(container[envelopeKey]);
      if (!endpointEnvelope) continue;
      addContainer(endpointEnvelope);
      addList(endpointEnvelope.items, endpointEnvelope);
      addList(endpointEnvelope[pluralKey], endpointEnvelope);
      addList(endpointEnvelope[endpointKey], endpointEnvelope);
      addList(endpointEnvelope.data, endpointEnvelope);

      const endpointData = asRecord(endpointEnvelope.data);
      if (!endpointData) continue;
      addContainer(endpointData);
      addList(endpointData.items, endpointData);
      addList(endpointData[pluralKey], endpointData);
      addList(endpointData[endpointKey], endpointData);
    }
  }

  // Some list envelopes omit the endpoint-named outer wrapper but retain a
  // direct `data.data.<endpoint-list-key>` payload.
  const nestedData = asRecord(data?.data);
  if (nestedData) {
    const hasKnownList = [
      nestedData.items,
      nestedData[pluralKey],
      ...endpointEnvelopeKeys.map((key) => nestedData[key]),
    ].some(Array.isArray);
    if (hasKnownList) {
      addContainer(nestedData);
      addList(nestedData.items, nestedData);
      addList(nestedData[pluralKey], nestedData);
      for (const key of endpointEnvelopeKeys) addList(nestedData[key], nestedData);
    }
  }

  return { lists, totalContainers };
}

function findAssociatedListTotal(containers: readonly Record<string, unknown>[]): number | undefined {
  for (const container of containers) {
    for (const key of ["total_count", "total", "count", "records"] as const) {
      const value = container[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
    }
  }
  return undefined;
}

export function parseFieldConfiguration(payload: unknown, entityType: EntityType, workspaceId: string): FieldConfigurationResult {
  const fields = new Map<string, FieldDefinition>();
  const workItemTypes = new Map<string, WorkItemTypeOption>();
  parseExplicitWorkItemTypeMap(payload, workItemTypes);
  for (const record of collectCandidateRecords(payload, 1_500)) {
    const fieldName = readString(record, "field", "field_name", "key", "name");
    if (fieldName && ("html_type" in record || "options" in record || "field_options" in record || "editable" in record)) {
      fields.set(fieldName, {
        name: fieldName,
        label: readString(record, "label", "name", "field_label"),
        htmlType: readString(record, "html_type", "htmlType"),
        required: readBoolean(record, "required", "is_required", "Notnull"),
        editable: !(record.editable === false || record.readonly === true || record.readonly === "1"),
        options: parseOptions(record.options ?? record.field_options ?? record.values),
      });
    }
    const typeId = readString(record, "workitem_type_id", "workitemTypeId", "type_id");
    if (typeId && /^\d+$/.test(typeId)) {
      workItemTypes.set(typeId, {
        id: typeId,
        name: readString(record, "workitem_type_name", "type_name", "name") ?? typeId,
        isDefault: readBoolean(record, "is_default", "default", "isDefault"),
      });
    }
  }
  if (fields.size === 0) {
    throw new ContractChangedError(
      entityType === "story" ? "story_aggregation.get_story_fields" : "bug_aggregation.get_bug_fields",
      "at least one recognised field definition",
    );
  }
  return { entityType, workspaceId, fields: [...fields.values()], workItemTypes: [...workItemTypes.values()] };
}

/**
 * Some TAPD workspaces omit workitem_type_map from the new-filter response.
 * A confirmed Story detail exposes the same workspace-scoped catalog under
 * all_workitem_types. This parser intentionally accepts only explicit numeric
 * id/name records beneath those dedicated containers.
 */
export function parseStoryWorkItemTypes(payload: unknown): WorkItemTypeOption[] {
  const types = new Map<string, WorkItemTypeOption>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 5_000) {
    const current = pending.pop()!;
    if (current.depth > 16) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const record = asRecord(current.value);
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      if (key === "all_workitem_types" || key === "workitem_types") {
        collectStoryWorkItemTypes(value, types);
      }
      pending.push({ value, depth: current.depth + 1 });
    }
  }
  return [...types.values()];
}

function collectStoryWorkItemTypes(value: unknown, target: Map<string, WorkItemTypeOption>): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length && visited < 1_000) {
    const current = pending.pop();
    visited += 1;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record) continue;
    const id = readString(record, "id", "workitem_type_id");
    const name = readString(record, "name", "workitem_type_name");
    if (id && /^[1-9]\d*$/.test(id) && name) {
      target.set(id, { id, name, isDefault: readBoolean(record, "is_default", "default", "isDefault") });
    }
    pending.push(...Object.values(record));
  }
}

function parseExplicitWorkItemTypeMap(payload: unknown, target: Map<string, WorkItemTypeOption>): void {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const meta = asRecord(data?.meta);
  const typeMap = asRecord(meta?.workitem_type_map);
  if (!typeMap) return;

  for (const [mapId, value] of Object.entries(typeMap)) {
    const record = asRecord(value);
    if (!record || !/^[1-9]\d*$/.test(mapId)) continue;
    const recordId = readString(record, "id");
    const name = readString(record, "name");
    if (recordId !== mapId || !name) continue;
    target.set(recordId, {
      id: recordId,
      name,
      isDefault: readBoolean(record, "is_default", "default", "isDefault"),
    });
  }
}

export function parseTransitionList(
  payload: unknown,
  entityType: EntityType,
  workspaceId: string,
  id: string,
): Omit<TransitionListResult, "requestId"> {
  const records = collectCandidateRecords(payload, 1_500);
  const candidates = records
    .filter((record) => Boolean(readString(record, "current_status", "currentStatus")))
    .sort((left, right) => Number(hasStatusAliases(right)) - Number(hasStatusAliases(left)));

  for (const container of candidates) {
    const currentStatus = readString(container, "current_status", "currentStatus")!;
    const aliases = parseStringMap(container.status_alias ?? container.statusAliases ?? container.status_name_map);
    const knownRawTransitions = container.my_all_transitions ?? container.all_transitions ?? container.transitions;
    const resolved = knownRawTransitions !== undefined
      ? { raw: knownRawTransitions, transitions: parseTransitions(knownRawTransitions, currentStatus, aliases) }
      : findUniqueTransitionCollection(container, currentStatus, aliases);
    if (!resolved) continue;
    if (collectionSize(resolved.raw) > 0 && resolved.transitions.length === 0) continue;
    return {
      entityType,
      workspaceId,
      id,
      currentStatus,
      currentStatusName: aliases[currentStatus],
      statusAliases: aliases,
      transitions: resolved.transitions,
    };
  }
  throw new ContractChangedError(transitionInfoEndpoint(entityType), "current_status and one unambiguous alias-constrained transition collection");
}

export function parseTransitionMutation(
  payload: unknown,
  entityType: EntityType,
  workspaceId: string,
  id: string,
  previousStatus: string,
  fallbackStatus: string,
  submittedPlainText = "",
): Omit<TransitionMutationResult, "requestId"> {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  if (!data) throw new ContractChangedError(transitionMutationEndpoint(entityType), "transition result data");
  const status = readString(data, "status", "new_status");
  if (!status || status !== fallbackStatus) {
    throw new ContractChangedError(transitionMutationEndpoint(entityType), "the confirmed requested target status");
  }
  const responseId = readString(data, "id", entityType === "story" ? "story_id" : "bug_id");
  if (responseId && responseId !== id) {
    throw new ContractChangedError(transitionMutationEndpoint(entityType), "the requested work-item id");
  }
  const statusName = readString(data, "status_name", "status_alias", "new_status_name_cn");
  const comments = parseComments(data.comment, submittedPlainText);
  if (submittedPlainText && comments.length === 0) {
    throw new ContractChangedError(
      transitionMutationEndpoint(entityType),
      "a persisted comment record with a positive id and matching comment text",
    );
  }
  return {
    entityType,
    workspaceId,
    id: responseId ?? id,
    previousStatus,
    status,
    statusName,
    message: readString(data, "message"),
    comments,
  };
}

export function parseDeleteResult(payload: unknown, entityType: EntityType, workspaceId: string, id: string): DeleteResult {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const result = data?.result;
  if (!(result === 1 || result === "1" || result === true)) {
    throw new ContractChangedError(deleteEndpoint(entityType), "data.result equal to 1");
  }
  return { entityType, workspaceId, id, deleted: true };
}

export function assertExpectedWorkspace(item: WorkItemResult, workspaceId: string, entityType: EntityType): void {
  if (item.workspaceId !== workspaceId || item.entityType !== entityType) {
    throw new TapdRequestError("work_item_preflight", "The resolved work item does not belong to the requested workspace and type.");
  }
}

function tryNormalizeWorkItem(record: Record<string, unknown>, entityType: EntityType, workspaceId: string): WorkItemResult | undefined {
  const nested = asRecord(record[entityType === "story" ? "Story" : "Bug"]);
  const source = nested ?? record;
  const id = readString(source, "id", entityType === "story" ? "story_id" : "bug_id");
  const title = entityType === "story"
    ? readString(source, "name", "title")
    : readString(source, "title", "name");
  const status = readString(source, "status", "current_status", "new_status");
  const actualWorkspace = readString(source, "workspace_id", "workspaceId", "project_id")
    ?? readString(record, "workspace_id", "workspaceId", "project_id");
  if (!id || !/^\d+$/.test(id) || !title || !status || actualWorkspace !== workspaceId) return undefined;
  const declaredType = readString(source, "entity_type", "entityType");
  if (declaredType && declaredType.toLowerCase() !== entityType) return undefined;
  const declaredShortId = readString(source, "short_id", "shortId");
  const derivedShortId = shortIdFromTapdFullId(id, workspaceId);
  if (declaredShortId && derivedShortId && declaredShortId !== derivedShortId) return undefined;
  return {
    entityType,
    id,
    shortId: declaredShortId ?? derivedShortId,
    title,
    status,
    statusName: readString(source, "status_name", "status_alias", "new_status_name_cn"),
    workspaceId: actualWorkspace,
    description: readString(source, "description"),
    markdownDescription: readString(source, "markdown_description"),
  };
}

/** Expands a public 1-9 digit TAPD short ID into its workspace-scoped full ID. */
export function toTapdFullId(workspaceId: string, id: string): string {
  if (!/^[1-9]\d{0,8}$/.test(id)) return id;
  return `11${workspaceId}${id.padStart(9, "0")}`;
}

function shortIdFromTapdFullId(id: string, workspaceId: string): string | undefined {
  const prefix = `11${workspaceId}`;
  if (!id.startsWith(prefix)) return undefined;
  const encoded = id.slice(prefix.length);
  if (!/^\d{9}$/.test(encoded)) return undefined;
  const shortId = encoded.replace(/^0+/, "");
  return shortId && shortId !== "0" ? shortId : undefined;
}

interface ResolvedTransitionCollection {
  raw: unknown;
  transitions: TransitionOption[];
}

function hasStatusAliases(record: Record<string, unknown>): boolean {
  const aliases = asRecord(record.status_alias ?? record.statusAliases ?? record.status_name_map);
  return Boolean(aliases && Object.keys(aliases).length > 0);
}

function findUniqueTransitionCollection(
  container: Record<string, unknown>,
  currentStatus: string,
  aliases: Record<string, string>,
): ResolvedTransitionCollection | undefined {
  if (!Object.hasOwn(aliases, currentStatus)) return undefined;
  const candidates = new Map<string, ResolvedTransitionCollection>();
  for (const [key, raw] of Object.entries(container)) {
    if (/^(?:current_status|currentStatus|status_alias|statusAliases|status_name_map)$/i.test(key)) continue;
    if (collectionSize(raw) === 0) continue;
    const parsed = parseTransitions(raw, currentStatus, aliases)
      .filter((transition) => transition.fromStatus === currentStatus);
    if (parsed.length === 0) continue;
    if (parsed.some((transition) => !Object.hasOwn(aliases, transition.toStatus))) continue;
    const signature = JSON.stringify(parsed
      .map((transition) => ({
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        fields: transition.fields.map((field) => ({ name: field.name, required: field.required })),
      }))
      .sort((left, right) => left.toStatus.localeCompare(right.toStatus)));
    candidates.set(signature, { raw, transitions: parsed });
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

function parseTransitions(value: unknown, currentStatus: string, aliases: Record<string, string>): TransitionOption[] {
  const entries: Array<{ hint?: string; value: unknown }> = Array.isArray(value)
    ? value.map((item) => ({ value: item }))
    : asRecord(value)
      ? Object.entries(asRecord(value)!).map(([hint, item]) => ({ hint, value: item }))
      : [];
  const result: TransitionOption[] = [];
  for (const entry of entries) {
    const records = collectCandidateRecords(entry.value, 80);
    const merged = records.length ? records : [asRecord(entry.value)].filter(Boolean) as Record<string, unknown>[];
    const source = findStringByKeys(merged, [
      "source_status", "from_status", "pre_status", "current_status", "StepPrevious", "step_previous",
    ]) ?? currentStatus;
    const target = findStringByKeys(merged, [
      "destination_status", "dest_status", "to_status", "target_status", "new_status", "next_status", "status_to",
      "StepNext", "step_next",
    ]) ?? parseTargetFromHint(entry.hint, currentStatus);
    if (!target) continue;
    const appendFields = findValueByKeys(merged, ["Appendfield", "appendfield", "append_fields", "fields"]);
    result.push({
      fromStatus: source,
      toStatus: target,
      toStatusName: aliases[target],
      name: findStringByKeys(merged, ["transition_name", "name", "Name", "label", "title"]),
      fields: parseTransitionFields(appendFields),
    });
  }
  return dedupeTransitions(result);
}

function parseTransitionFields(value: unknown): TransitionField[] {
  const entries: Array<{ hint?: string; value: unknown }> = Array.isArray(value)
    ? value.map((item) => ({ value: item }))
    : asRecord(value)
      ? Object.entries(asRecord(value)!).map(([hint, item]) => ({ hint, value: item }))
      : [];
  const fields: TransitionField[] = [];
  for (const entry of entries) {
    const record = asRecord(entry.value);
    if (!record) continue;
    const name = readString(record, "field", "field_name", "FieldName", "key", "name") ?? entry.hint;
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    fields.push({
      name,
      label: readString(record, "label", "show_name", "field_label", "FieldLabel"),
      required: readBoolean(record, "required", "is_required", "Notnull", "notnull"),
      htmlType: readString(record, "html_type", "htmlType", "Type"),
    });
  }
  return fields;
}

function parseComments(value: unknown, submittedPlainText: string): CommentResult[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const comments: CommentResult[] = [];
  const expectedPlainText = normalizeCommentText(submittedPlainText);
  for (const item of values) {
    const record = asRecord(item);
    if (!record) continue;
    const id = readString(record, "id", "comment_id", "entry_id");
    const plainText = readCommentPlainText(record);
    if (!id || !/^[1-9]\d*$/.test(id) || !plainText) continue;
    if (expectedPlainText && plainText !== expectedPlainText) continue;
    comments.push({
      id,
      plainText,
      author: readString(record, "author", "creator"),
      createdAt: readString(record, "created", "created_at", "createdAt"),
    });
  }
  return comments;
}

function readCommentPlainText(record: Record<string, unknown>): string | undefined {
  if (typeof record.plain_text === "string") return normalizeCommentText(record.plain_text);
  if (typeof record.description !== "string") return undefined;
  const withoutMarkup = record.description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return normalizeCommentText(decodeCommentHtmlEntities(withoutMarkup));
}

function decodeCommentHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Only reconcile transport line endings and the outer trim already applied to submitted comments. */
function normalizeCommentText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function parseOptions(value: unknown): FieldOption[] | undefined {
  const result: FieldOption[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      if (record) {
        const optionValue = readString(record, "value", "id", "key");
        if (optionValue) result.push({ value: optionValue, label: readString(record, "label", "name", "title") ?? optionValue });
      } else if (typeof item === "string" || typeof item === "number") {
        result.push({ value: String(item), label: String(item) });
      }
    }
  } else if (asRecord(value)) {
    for (const [optionValue, label] of Object.entries(asRecord(value)!)) {
      if (typeof label === "string" || typeof label === "number") result.push({ value: optionValue, label: String(label) });
    }
  }
  return result.length ? result : undefined;
}

function parseStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function collectCandidateRecords(root: unknown, maxNodes: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  while (queue.length && seen.size < maxNodes) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) queue.push(...current);
    else {
      const record = current as Record<string, unknown>;
      records.push(record);
      queue.push(...Object.values(record));
    }
  }
  return records;
}

function findStringByKeys(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const key of keys) for (const record of records) {
    const value = readString(record, key);
    if (value) return value;
  }
  return undefined;
}

function findValueByKeys(records: Record<string, unknown>[], keys: string[]): unknown {
  for (const key of keys) for (const record of records) if (key in record) return record[key];
  return undefined;
}

function parseTargetFromHint(hint: string | undefined, currentStatus: string): string | undefined {
  if (!hint) return undefined;
  const match = hint.match(/(?:STATUS_)?([^\s]+)-([^\s]+)$/i);
  return match && match[1] === currentStatus ? match[2] : undefined;
}

function dedupeTransitions(values: TransitionOption[]): TransitionOption[] {
  const map = new Map<string, TransitionOption>();
  for (const value of values) map.set(`${value.fromStatus}->${value.toStatus}`, value);
  return [...map.values()];
}

function collectionSize(value: unknown): number {
  return Array.isArray(value) ? value.length : asRecord(value) ? Object.keys(asRecord(value)!).length : 0;
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (value === true || value === 1 || value === "1" || value === "yes" || value === "true") return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function looksLikeSessionFailure(message: string): boolean {
  return /(?:dsc[_\s-]*token|login|log\s*in|登录|登陆|会话|session|未认证|认证失败)/i.test(message);
}

function detailEndpoint(type: EntityType): string {
  return type === "story" ? "stories.get_info" : "bugs.get_info";
}
function listEndpoint(type: EntityType): string {
  return type === "story" ? "story_aggregation.get_stories_list" : "bug_aggregation.get_bugs_list";
}
function transitionInfoEndpoint(type: EntityType): string {
  return type === "story" ? "story_aggregation.get_story_transition_info" : "bug_aggregation.get_bug_transition_info";
}
function transitionMutationEndpoint(type: EntityType): string {
  return type === "story" ? "workflow.change_story_status" : "workflow.change_bug_status";
}
function deleteEndpoint(type: EntityType): string {
  return type === "story" ? "stories.delete" : "bugs.batch_delete";
}
