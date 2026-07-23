import type { EntityType, WorkItemResult } from "../private-api/contracts.js";
import { ContractChangedError } from "../private-api/errors.js";

export interface CreateReceipt {
  id: string;
}

export interface ExpectedCreatedWorkItem {
  endpoint: string;
  entityType: EntityType;
  id: string;
  workspaceId: string;
  title: string;
}

export function parseStoryCreateReceipt(payload: unknown): CreateReceipt {
  return parseCreateReceipt(payload, "story", "stories.quickly_create");
}

export function parseBugCreateReceipt(payload: unknown): CreateReceipt {
  return parseCreateReceipt(payload, "bug", "bugs.create");
}

export function assertExactCreateConfirmation(
  item: WorkItemResult,
  expected: ExpectedCreatedWorkItem,
): void {
  if (
    item.id !== expected.id
    || item.workspaceId !== expected.workspaceId
    || item.entityType !== expected.entityType
    || item.title !== expected.title
  ) {
    throw new ContractChangedError(
      expected.endpoint,
      "a confirmation detail with the exact created full id, workspace_id, entity type, and title",
    );
  }
}

function parseCreateReceipt(
  payload: unknown,
  entityType: EntityType,
  endpoint: string,
): CreateReceipt {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const wrapperName = entityType === "story" ? "Story" : "Bug";
  const records = [
    data,
    asRecord(data?.[wrapperName]),
    asRecord(root?.[wrapperName]),
  ];
  const candidateIds = new Set<string>();

  for (const record of records) {
    const id = positiveNumericId(record?.id);
    if (id) candidateIds.add(id);
  }

  if (candidateIds.size !== 1) {
    throw new ContractChangedError(
      endpoint,
      "exactly one positive numeric id at the endpoint's direct create receipt paths",
    );
  }

  return { id: candidateIds.values().next().value! };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumericId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return undefined;
}
