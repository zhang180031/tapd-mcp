export class WorkspaceContextRequiredError extends Error {
  override readonly name = "WorkspaceContextRequiredError";
  readonly code = "WORKSPACE_CONTEXT_REQUIRED" as const;

  constructor(
    readonly workspaceId?: string,
    message = workspaceId
      ? `No usable TAPD session context exists for workspace_id ${workspaceId}.`
      : "workspace_id is required for every TAPD operation.",
  ) {
    super(message);
  }
}

export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
  readonly code = "SESSION_EXPIRED" as const;

  constructor(
    readonly workspaceId: string,
    message = `The TAPD login session for workspace_id ${workspaceId} has expired. Refresh the session before retrying.`,
  ) {
    super(message);
  }
}

export class ChromeLoginBridgeError extends Error {
  override readonly name: string = "ChromeLoginBridgeError";
  readonly code = "CHROME_LOGIN_BRIDGE_ERROR" as const;
}

export class ChromeLoginBridgeStateError extends ChromeLoginBridgeError {
  override readonly name: string = "ChromeLoginBridgeStateError";
  readonly stateCode = "INVALID_LOGIN_BRIDGE_STATE" as const;
}
