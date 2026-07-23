import type { SafeCookieJar } from "./cookie-jar.js";

export type TapdSessionState = "missing" | "waiting_for_login" | "valid" | "expired";

export interface TapdEntitySessionContext {
  readonly confId?: string;
  readonly queryToken?: string;
  readonly workitemTypeId?: string;
}

export interface TapdWorkspaceSessionInput {
  workspaceId?: string;
  cookieJar: SafeCookieJar;
  dscToken: string;
  confId?: string;
  queryToken?: string;
  workitemTypeId?: string;
  storyContext?: TapdEntitySessionContext;
  bugContext?: TapdEntitySessionContext;
  capturedAt?: number;
  expiresAt?: number;
}

export interface TapdWorkspaceSessionContext {
  readonly workspaceId: string;
  readonly cookieJar: SafeCookieJar;
  readonly dscToken: string;
  readonly confId?: string;
  readonly queryToken?: string;
  readonly workitemTypeId?: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
  readonly capturedAt: number;
  readonly expiresAt?: number;
}

/**
 * A browser-executed session deliberately contains no Cookie or CSRF value.
 * The authenticated request is performed by the existing TAPD Chrome tab, so
 * its browser-owned credentials never cross into the MCP process.
 */
export interface TapdChromeDevToolsSessionInput {
  workspaceId?: string;
  storyContext?: TapdEntitySessionContext;
  bugContext?: TapdEntitySessionContext;
  capturedAt?: number;
  expiresAt?: number;
}

export interface TapdChromeDevToolsSessionContext {
  readonly workspaceId: string;
  readonly transport: "chrome_devtools";
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
  readonly capturedAt: number;
  readonly expiresAt?: number;
}

export interface TapdRequestSessionContext {
  readonly workspaceId: string;
  readonly cookieHeader: string;
  readonly dscToken: string;
  readonly confId?: string;
  readonly queryToken?: string;
  readonly workitemTypeId?: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
}

export interface TapdSessionStatus {
  readonly workspaceId: string;
  readonly state: TapdSessionState;
  readonly updatedAt?: number;
  readonly reason?: string;
}
