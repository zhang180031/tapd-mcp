import { redactSensitive } from "../security/redaction.js";
import { SafeCookieJar } from "./cookie-jar.js";
import { SessionExpiredError, WorkspaceContextRequiredError } from "./errors.js";
import type {
  TapdRequestSessionContext,
  TapdChromeDevToolsSessionContext,
  TapdChromeDevToolsSessionInput,
  TapdSessionState,
  TapdSessionStatus,
  TapdWorkspaceSessionContext,
  TapdWorkspaceSessionInput,
} from "./types.js";

export interface TapdSessionManagerOptions {
  clock?: () => number;
  requestOrigin?: string;
  onSessionChanged?: (workspaceId: string, context: Readonly<TapdWorkspaceSessionContext> | undefined) => void;
}

interface SessionRecord {
  state: TapdSessionState;
  context?: TapdWorkspaceSessionContext;
  chromeDevToolsContext?: TapdChromeDevToolsSessionContext;
  priorState?: TapdSessionState;
  updatedAt: number;
  reason?: string;
}

export class TapdSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clock: () => number;
  private readonly requestOrigin: string;
  private readonly onSessionChanged?: TapdSessionManagerOptions["onSessionChanged"];

  constructor(options: TapdSessionManagerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.requestOrigin = options.requestOrigin ?? "https://www.tapd.cn/";
    this.onSessionChanged = options.onSessionChanged;
  }

  getState(workspaceId: string): TapdSessionState {
    const id = requireWorkspaceId(workspaceId);
    const record = this.sessions.get(id);
    if (!record) return "missing";
    this.expireIfNeeded(id, record);
    return record.state;
  }

  getStatus(workspaceId: string): TapdSessionStatus {
    const id = requireWorkspaceId(workspaceId);
    const record = this.sessions.get(id);
    if (!record) return { workspaceId: id, state: "missing" };
    this.expireIfNeeded(id, record);
    return {
      workspaceId: id,
      state: record.state,
      updatedAt: record.updatedAt,
      reason: record.reason,
    };
  }

  beginLogin(workspaceId: string): void {
    const id = requireWorkspaceId(workspaceId);
    const current = this.sessions.get(id);
    this.sessions.set(id, {
      state: "waiting_for_login",
      context: current?.context,
      chromeDevToolsContext: current?.chromeDevToolsContext,
      priorState: current?.state ?? "missing",
      updatedAt: this.clock(),
    });
  }

  completeLogin(workspaceId: string, input: TapdWorkspaceSessionInput): void {
    const id = requireWorkspaceId(workspaceId);
    if (input.workspaceId && requireWorkspaceId(input.workspaceId) !== id) {
      throw new WorkspaceContextRequiredError(id, "The captured TAPD session belongs to a different workspace_id.");
    }
    const dscToken = input.dscToken.trim();
    const cookieJar = input.cookieJar.clone();
    if (!dscToken || !cookieJar.getCookieHeader(this.requestOrigin)) {
      throw new WorkspaceContextRequiredError(id, "A TAPD Cookie header and dsc_token are required to complete login.");
    }

    this.sessions.get(id)?.context?.cookieJar.clear();
    const context = Object.freeze({
      workspaceId: id,
      cookieJar,
      dscToken,
      confId: optionalListToken(input.confId),
      queryToken: optionalListToken(input.queryToken),
      workitemTypeId: optionalToken(input.workitemTypeId),
      storyContext: freezeEntityContext(input.storyContext ?? {
        confId: input.confId,
        queryToken: input.queryToken,
        workitemTypeId: input.workitemTypeId,
      }),
      bugContext: freezeEntityContext(input.bugContext),
      capturedAt: input.capturedAt ?? this.clock(),
      expiresAt: input.expiresAt,
    });
    this.sessions.set(id, {
      state: "valid",
      context,
      updatedAt: this.clock(),
    });
    this.notifySessionChanged(id, context);
  }

  /** Marks a workspace as usable through the user's existing Chrome tab.
   * No browser Cookie or dsc_token is accepted or retained here. */
  completeChromeDevToolsLogin(workspaceId: string, input: TapdChromeDevToolsSessionInput): void {
    const id = requireWorkspaceId(workspaceId);
    if (input.workspaceId && requireWorkspaceId(input.workspaceId) !== id) {
      throw new WorkspaceContextRequiredError(id, "The captured TAPD browser page belongs to a different workspace_id.");
    }
    this.sessions.get(id)?.context?.cookieJar.clear();
    this.sessions.set(id, {
      state: "valid",
      chromeDevToolsContext: Object.freeze({
        workspaceId: id,
        transport: "chrome_devtools",
        storyContext: freezeEntityContext(input.storyContext),
        bugContext: freezeEntityContext(input.bugContext),
        capturedAt: input.capturedAt ?? this.clock(),
        expiresAt: input.expiresAt,
      }),
      updatedAt: this.clock(),
    });
    this.notifySessionChanged(id, undefined);
  }

  cancelLogin(workspaceId: string): void {
    const id = requireWorkspaceId(workspaceId);
    const record = this.sessions.get(id);
    if (!record || record.state !== "waiting_for_login") return;
    const restoredState = record.priorState ?? (record.context || record.chromeDevToolsContext ? "expired" : "missing");
    if (restoredState === "missing" && !record.context && !record.chromeDevToolsContext) {
      this.sessions.delete(id);
      return;
    }
    this.sessions.set(id, {
      state: restoredState,
      context: record.context,
      chromeDevToolsContext: record.chromeDevToolsContext,
      updatedAt: this.clock(),
      reason: restoredState === "expired" ? "Login refresh was cancelled." : undefined,
    });
  }

  markExpired(workspaceId: string, reason = "TAPD rejected the current login session."): void {
    const id = requireWorkspaceId(workspaceId);
    const current = this.sessions.get(id);
    this.sessions.set(id, {
      state: "expired",
      context: current?.context,
      chromeDevToolsContext: current?.chromeDevToolsContext,
      updatedAt: this.clock(),
      reason: safeReason(reason),
    });
    this.notifySessionChanged(id, undefined);
  }

  clear(workspaceId: string): void {
    const id = requireWorkspaceId(workspaceId);
    this.sessions.get(id)?.context?.cookieJar.clear();
    this.sessions.delete(id);
    this.notifySessionChanged(id, undefined);
  }

  requireValidContext(workspaceId: string): Readonly<TapdWorkspaceSessionContext> {
    const id = requireWorkspaceId(workspaceId);
    const record = this.sessions.get(id);
    if (!record || record.state === "missing" || record.state === "waiting_for_login") {
      throw new WorkspaceContextRequiredError(id);
    }
    this.expireIfNeeded(id, record);
    if (record.state === "expired" || !record.context) throw new SessionExpiredError(id);
    return record.context;
  }

  requireChromeDevToolsContext(workspaceId: string): Readonly<TapdChromeDevToolsSessionContext> {
    const id = requireWorkspaceId(workspaceId);
    const record = this.sessions.get(id);
    if (!record || record.state === "missing" || record.state === "waiting_for_login") {
      throw new WorkspaceContextRequiredError(id);
    }
    this.expireIfNeeded(id, record);
    if (record.state === "expired" || !record.chromeDevToolsContext) throw new SessionExpiredError(id);
    return record.chromeDevToolsContext;
  }

  getRequestContext(
    workspaceId: string,
    requestUrl = this.requestOrigin,
  ): TapdRequestSessionContext {
    const context = this.requireValidContext(workspaceId);
    const cookieHeader = context.cookieJar.getCookieHeader(requestUrl);
    if (!cookieHeader) {
      this.markExpired(context.workspaceId, "The TAPD session cookies have expired.");
      throw new SessionExpiredError(context.workspaceId);
    }
    return {
      workspaceId: context.workspaceId,
      cookieHeader,
      dscToken: context.dscToken,
      confId: context.confId,
      queryToken: context.queryToken,
      workitemTypeId: context.workitemTypeId,
      storyContext: context.storyContext,
      bugContext: context.bugContext,
    };
  }

  mergeSetCookieHeaders(
    workspaceId: string,
    headers: string | readonly string[],
    requestUrl = this.requestOrigin,
  ): void {
    const context = this.requireValidContext(workspaceId);
    context.cookieJar.mergeSetCookie(headers, requestUrl);
    this.notifySessionChanged(context.workspaceId, context);
  }

  private expireIfNeeded(workspaceId: string, record: SessionRecord): void {
    if (record.state !== "valid") return;
    const expiresAt = record.context?.expiresAt ?? record.chromeDevToolsContext?.expiresAt;
    if (expiresAt !== undefined && expiresAt <= this.clock()) {
      record.state = "expired";
      record.updatedAt = this.clock();
      record.reason = "The TAPD session lifetime has elapsed.";
      this.notifySessionChanged(workspaceId, undefined);
      return;
    }
    if (record.context && !record.context.cookieJar.getCookieHeader(this.requestOrigin)) {
      record.state = "expired";
      record.updatedAt = this.clock();
      record.reason = "The TAPD session cookies have expired.";
      this.notifySessionChanged(workspaceId, undefined);
    }
  }

  private notifySessionChanged(workspaceId: string, context: Readonly<TapdWorkspaceSessionContext> | undefined): void {
    this.onSessionChanged?.(workspaceId, context);
  }
}

function requireWorkspaceId(workspaceId: string | undefined): string {
  const id = workspaceId?.trim();
  if (!id || !/^[1-9]\d*$/.test(id)) {
    throw new WorkspaceContextRequiredError(undefined, "workspace_id is required and must be a positive numeric string.");
  }
  return id;
}

function optionalToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function optionalListToken(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim();
}

function freezeEntityContext(
  value: TapdWorkspaceSessionInput["storyContext"] | TapdWorkspaceSessionInput["bugContext"],
): TapdWorkspaceSessionInput["storyContext"] | undefined {
  if (!value) return undefined;
  const context = {
    confId: optionalListToken(value.confId),
    queryToken: optionalListToken(value.queryToken),
    workitemTypeId: optionalToken(value.workitemTypeId),
  };
  return context.confId !== undefined || context.queryToken !== undefined || context.workitemTypeId !== undefined
    ? Object.freeze(context)
    : undefined;
}

function safeReason(reason: string): string {
  const redacted = redactSensitive(reason);
  return (typeof redacted === "string" ? redacted : "TAPD session expired.").slice(0, 300);
}
