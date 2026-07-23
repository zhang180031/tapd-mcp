import type { EditableValue, EntityType, TransitionListResult, TransitionMutationResult, WorkItemMutationResult } from "../private-api/contracts.js";
import type { ListContextInput } from "./workspace-context-service.js";
import type { TapdMention } from "./mentions.js";

export type ListFilterValue = EditableValue | readonly (string | number | boolean)[];

export interface ListWorkItemsInput {
  workspaceId: string;
  page?: number;
  perPage?: number;
  sortName?: string;
  order?: "asc" | "desc";
  filters?: Readonly<Record<string, ListFilterValue>>;
  listContext?: ListContextInput;
}

export interface GetWorkItemInput {
  workspaceId: string;
  id: string;
}

export interface UpdateFieldsInput {
  workspaceId: string;
  id: string;
  fields: Readonly<Record<string, EditableValue>>;
}

export interface UpdateFieldInput {
  workspaceId: string;
  id: string;
  field: string;
  value: EditableValue;
}

export interface DeleteWorkItemInput {
  workspaceId: string;
  id: string;
  confirm: boolean;
}

export interface TransitionInput {
  workspaceId: string;
  entityType: EntityType;
  id: string;
  targetStatus: string;
  transitionFields?: Readonly<Record<string, string>>;
  comment?: string;
  mentions?: readonly TapdMention[];
}

export interface GetTransitionsInput {
  workspaceId: string;
  entityType: EntityType;
  id: string;
}

export interface AddCommentInput {
  workspaceId: string;
  entityType: EntityType;
  id: string;
  comment: string;
  mentions?: readonly TapdMention[];
}

export type AdvanceResult =
  | TransitionMutationResult
  | {
      requiresChoice: true;
      entityType: EntityType;
      workspaceId: string;
      id: string;
      currentStatus: string;
      candidates: TransitionListResult["transitions"];
    };

export type { WorkItemMutationResult };
