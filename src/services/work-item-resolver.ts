import {
  assertExpectedWorkspace,
  parseWorkItemDetail,
  requireNumericId,
  toTapdFullId,
  type EntityType,
  type WorkItemResult,
} from "../private-api/contracts.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";

export interface ResolveWorkItemInput {
  workspaceId: string;
  entityType: EntityType;
  id: string;
}

/** Resolves either a short or full numeric ID and verifies type/workspace before writes. */
export class WorkItemResolver {
  constructor(private readonly client: PrivateHttpClient) {}

  async resolve(input: ResolveWorkItemInput): Promise<WorkItemResult & { requestId?: string }> {
    const workspaceId = requireNumericId(input.workspaceId, "workspace_id");
    const id = requireNumericId(input.id, "id");
    const endpointId = toTapdFullId(workspaceId, id);
    const story = input.entityType === "story";
    const response = await this.client.get({
      workspaceId,
      endpoint: story ? "stories.get_info" : "bugs.get_info",
      path: story ? "/api/entity/stories/get_info" : "/api/entity/bugs/get_info",
      query: story
        ? { story_id: endpointId, workspace_id: workspaceId, enable_description: true, is_detail: 1 }
        : { id: endpointId, workspace_id: workspaceId, enable_description: true, is_detail: 1 },
      parse: (payload) => parseWorkItemDetail(payload, input.entityType, workspaceId, id),
    });
    assertExpectedWorkspace(response.value, workspaceId, input.entityType);
    return { ...response.value, requestId: response.requestId };
  }
}
