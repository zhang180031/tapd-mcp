import {
  parseTransitionList,
  parseTransitionMutation,
  requireNonEmptyText,
  requireNumericId,
  type EntityType,
  type TransitionListResult,
  type TransitionMutationResult,
  type TransitionOption,
  type WorkItemResult,
} from "../private-api/contracts.js";
import { InvalidArgumentError, TapdRequestError } from "../private-api/errors.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";
import type { AddCommentInput, AdvanceResult, GetTransitionsInput, TransitionInput } from "./service-types.js";
import { WorkItemResolver } from "./work-item-resolver.js";
import { plainTextToHtml } from "./plain-text.js";
import { commentToHtml, type TapdMention } from "./mentions.js";

interface LoadedTransitions {
  item: WorkItemResult;
  metadata: TransitionListResult;
}

export class WorkflowService {
  private readonly resolver: WorkItemResolver;

  constructor(private readonly client: PrivateHttpClient, resolver?: WorkItemResolver) {
    this.resolver = resolver ?? new WorkItemResolver(client);
  }

  async getTransitions(input: GetTransitionsInput): Promise<TransitionListResult> {
    return (await this.load(input)).metadata;
  }

  async transition(input: TransitionInput): Promise<TransitionMutationResult> {
    const targetStatus = requireNonEmptyText(input.targetStatus, "target_status", 100);
    const loaded = await this.load(input);
    const transition = loaded.metadata.transitions.find(
      (candidate) => candidate.fromStatus === loaded.metadata.currentStatus && candidate.toStatus === targetStatus,
    );
    if (!transition) throw new InvalidArgumentError("target_status", "target_status is not an allowed transition for this work item.");
    return this.execute(loaded, transition, input.transitionFields ?? {}, input.comment, input.mentions);
  }

  async advanceToNextStep(input: GetTransitionsInput & { transitionFields?: Readonly<Record<string, string>>; comment?: string; mentions?: readonly TapdMention[] }): Promise<AdvanceResult> {
    const loaded = await this.load(input);
    const candidates = loaded.metadata.transitions.filter(
      (transition) => transition.fromStatus === loaded.metadata.currentStatus
        && isNormalForwardTransition(transition, loaded.metadata.currentStatus),
    );
    if (candidates.length !== 1) {
      return {
        requiresChoice: true,
        entityType: input.entityType,
        workspaceId: loaded.metadata.workspaceId,
        id: loaded.item.id,
        currentStatus: loaded.metadata.currentStatus,
        candidates,
      };
    }
    return this.execute(loaded, candidates[0], input.transitionFields ?? {}, input.comment, input.mentions);
  }

  async addComment(input: AddCommentInput): Promise<TransitionMutationResult> {
    const comment = requireNonEmptyText(input.comment, "comment", 10_000);
    const loaded = await this.load(input);
    const self = loaded.metadata.transitions.find(
      (candidate) => candidate.fromStatus === loaded.metadata.currentStatus
        && candidate.toStatus === loaded.metadata.currentStatus,
    );
    if (!self) throw new TapdRequestError("workflow.comment", "TAPD did not expose a comment self-transition for this work item.");
    return this.execute(loaded, self, {}, comment, input.mentions);
  }

  private async load(input: GetTransitionsInput): Promise<LoadedTransitions> {
    const workspaceId = requireNumericId(input.workspaceId, "workspace_id");
    const item = await this.resolver.resolve({ workspaceId, entityType: input.entityType, id: input.id });
    const story = input.entityType === "story";
    const response = await this.client.get({
      workspaceId,
      endpoint: story ? "story_aggregation.get_story_transition_info" : "bug_aggregation.get_bug_transition_info",
      path: story
        ? "/api/aggregation/story_aggregation/get_story_transition_info"
        : "/api/aggregation/bug_aggregation/get_bug_transition_info",
      query: story
        ? { workspace_id: workspaceId, story_id: item.id, field_blocker: "" }
        : { workspace_id: workspaceId, bug_id: item.id, program_id: "", has_rule_fields: "undefined", check_rule_fields: "undefined" },
      parse: (payload) => parseTransitionList(payload, input.entityType, workspaceId, item.id),
    });
    return { item, metadata: { ...response.value, requestId: response.requestId } };
  }

  private async execute(
    loaded: LoadedTransitions,
    transition: TransitionOption,
    suppliedFields: Readonly<Record<string, string>>,
    plainComment?: string,
    mentions?: readonly TapdMention[],
  ): Promise<TransitionMutationResult> {
    const workspaceId = loaded.metadata.workspaceId;
    const comment = plainComment === undefined ? "" : requireNonEmptyText(plainComment, "comment", 10_000);
    if (mentions?.length && !comment) {
      throw new InvalidArgumentError("mentions", "mentions require a non-empty comment containing every @nick(name) marker.");
    }
    const commentHtml = comment ? commentToHtml(comment, mentions) : "";
    const appendFields = buildTransitionFields(transition, suppliedFields, commentHtml);
    const statusKey = `STATUS_${loaded.metadata.currentStatus}-${transition.toStatus}`;
    const entityType = loaded.metadata.entityType;
    const commonComment = {
      description: commentHtml,
      markdown_description: "",
      description_type: 1,
      comment_location: "workflow_classic_bottom",
      npc_repo_path: "",
    };
    const data: Record<string, unknown> = entityType === "story"
      ? {
          type: "storieslist",
          new_status: transition.toStatus,
          checked_condition: 0,
          change_type: "",
          Story: { current_status: loaded.metadata.currentStatus, story_id: loaded.item.id, close_task: false, complete_effort: false },
          branch: {},
          Comment: commonComment,
          is_editor_or_markdown: 1,
          [statusKey]: appendFields,
        }
      : {
          Bug: { current_status: loaded.metadata.currentStatus, id: loaded.item.id, complete_effort: false },
          new_status: transition.toStatus,
          Comment: commonComment,
          is_editor_or_markdown: 1,
          branch: {},
          [statusKey]: appendFields,
        };
    const response = await this.client.post({
      workspaceId,
      endpoint: entityType === "story" ? "workflow.change_story_status" : "workflow.change_bug_status",
      path: entityType === "story" ? "/api/entity/workflow/change_story_status" : "/api/entity/workflow/change_bug_status",
      body: { workspace_id: workspaceId, data },
      parse: (payload) => parseTransitionMutation(
        payload,
        entityType,
        workspaceId,
        loaded.item.id,
        loaded.metadata.currentStatus,
        transition.toStatus,
        comment,
      ),
    });
    return { ...response.value, requestId: response.requestId };
  }
}

function buildTransitionFields(
  transition: TransitionOption,
  supplied: Readonly<Record<string, string>>,
  commentHtml: string,
): Record<string, string> {
  const expected = new Set(transition.fields.map((field) => field.name));
  for (const key of Object.keys(supplied)) {
    if (!expected.has(key)) throw new InvalidArgumentError("transition_fields", `Unexpected transition field ${key}.`);
  }
  const result: Record<string, string> = {};
  for (const field of transition.fields) {
    const suppliedValue = supplied[field.name];
    const value = suppliedValue === undefined
      ? (field.name === "remarks" && commentHtml ? commentHtml : "")
      : normalizeTransitionField(field.name, suppliedValue);
    if (field.required && !value.trim()) throw new InvalidArgumentError("transition_fields", `Transition field ${field.name} is required.`);
    result[field.name] = value;
  }
  return result;
}

function normalizeTransitionField(fieldName: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidArgumentError("transition_fields", `Transition field ${fieldName} must be a string.`);
  }
  if (value.length > 10_000) {
    throw new InvalidArgumentError("transition_fields", `Transition field ${fieldName} is too long.`);
  }
  if (fieldName === "remarks" || fieldName === "description") {
    return value ? plainTextToHtml(value, `transition_fields.${fieldName}`, 10_000) : "";
  }
  if (/[<>]/.test(value)) {
    throw new InvalidArgumentError("transition_fields", `Transition field ${fieldName} must not contain HTML markup.`);
  }
  return value;
}

function isNormalForwardTransition(transition: TransitionOption, currentStatus: string): boolean {
  if (transition.toStatus === currentStatus) return false;
  const text = `${transition.toStatus} ${transition.toStatusName ?? ""} ${transition.name ?? ""}`;
  return !/(?:rejected|suspend|hang|pause|reopen|rollback|reject|cancel|挂起|拒绝|驳回|重新打开|回退|撤销|取消)/i.test(text);
}
