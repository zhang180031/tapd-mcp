import { requireNonEmptyText, requireNumericId } from "../private-api/contracts.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";

export interface TapdMember {
  nick: string;
  name: string;
  display: string;
}

export interface SearchTapdMembersResult {
  workspaceId: string;
  candidates: TapdMember[];
  requestId?: string;
}

/** Reads the same workspace-scoped candidate list used by TAPD's members panel. */
export class MemberService {
  constructor(private readonly client: PrivateHttpClient) {}

  async search(input: { workspaceId: string; keyword: string }): Promise<SearchTapdMembersResult> {
    const workspaceId = requireNumericId(input.workspaceId, "workspace_id");
    const keyword = requireNonEmptyText(input.keyword, "keyword", 100);
    const response = await this.client.get({
      workspaceId,
      endpoint: "workspace.members.get_member_list",
      path: "/api/workspace/members/get_member_list",
      query: {
        workspace_id: workspaceId,
        keyword,
        page: 1,
        page_size: 50,
        need_permission: 0,
      },
      parse: parseMembers,
    });
    return { workspaceId, candidates: response.value, requestId: response.requestId };
  }
}

function parseMembers(payload: unknown): TapdMember[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const values = Array.isArray(data?.list) ? data.list : [];
  const result = new Map<string, TapdMember>();
  for (const value of values) {
    const record = asRecord(value);
    const nick = typeof record?.nick === "string" ? record.nick.trim() : "";
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (!nick || !name || nick.length > 128 || name.length > 128) continue;
    result.set(nick, { nick, name, display: `${nick}(${name})` });
  }
  return [...result.values()];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
