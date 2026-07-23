export interface TapdConfig {
  webBaseUrl: string;
  maxRequestsPerMinute: number;
  requestTimeoutMs: number;
  /**
   * Optional user-owned business guidance. When it is unavailable, the MCP
   * still starts with its protocol and safety instructions only.
   */
  userPromptPath?: string;
  /** Optional cross-platform JSON store for the persisted TAPD Web session. */
  sessionStorePath?: string;
  /** Optional Chrome user-data directory override for the one-time DevTools capture. */
  chromeUserDataDir?: string;
}

export class TapdConfigurationError extends Error {
  override name = "TapdConfigurationError";
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TapdConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function tapdBaseUrl(value: string | undefined): string {
  const raw = optionalTrimmed(value) ?? "https://www.tapd.cn";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TapdConfigurationError("TAPD_WEB_BASE_URL must be a valid URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.tapd.cn") {
    throw new TapdConfigurationError("TAPD_WEB_BASE_URL must use https://www.tapd.cn.");
  }
  return url.origin;
}

export function requireWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!/^[1-9]\d*$/.test(workspaceId)) {
    throw new TapdConfigurationError("workspace_id is required and must be a positive numeric string.");
  }
  return workspaceId;
}

export function loadTapdConfig(env: NodeJS.ProcessEnv = process.env): TapdConfig {
  return {
    webBaseUrl: tapdBaseUrl(env.TAPD_WEB_BASE_URL),
    maxRequestsPerMinute: positiveInteger("TAPD_MAX_REQUESTS_PER_MINUTE", env.TAPD_MAX_REQUESTS_PER_MINUTE, 60),
    requestTimeoutMs: positiveInteger("TAPD_REQUEST_TIMEOUT_MS", env.TAPD_REQUEST_TIMEOUT_MS, 20_000),
    userPromptPath: optionalTrimmed(env.TAPD_USER_PROMPT_PATH),
    sessionStorePath: optionalTrimmed(env.TAPD_SESSION_STORE_PATH),
    chromeUserDataDir: optionalTrimmed(env.TAPD_CHROME_USER_DATA_DIR),
  };
}
