import type { TapdCookieInput } from "./cookie-jar.js";
import type { TapdEntitySessionContext } from "./types.js";

export const EXISTING_CHROME_SESSION_PROTOCOL = "tapd-existing-chrome/v1" as const;
// Kept short because macOS limits Unix-domain socket paths to roughly 104 bytes.
export const EXISTING_CHROME_HANDOFF_PREFIX = "tapd-mcp-xc-";
export const EXISTING_CHROME_REQUEST_PIPE_NAME = "capture.in";
export const EXISTING_CHROME_RESPONSE_PIPE_NAME = "capture.out";
export const MAX_EXISTING_CHROME_HANDOFF_BYTES = 256 * 1024;

export interface ExistingChromeSessionCapture {
  readonly workspaceId: string;
  readonly sourceOrigin: "https://www.tapd.cn";
  readonly cookies: readonly TapdCookieInput[];
  readonly dscToken: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
}

export interface ExistingChromeSessionEnvelope {
  readonly protocol: typeof EXISTING_CHROME_SESSION_PROTOCOL;
  readonly capture: ExistingChromeSessionCapture;
}

export interface ExistingChromeSessionHandoff {
  readonly protocol: typeof EXISTING_CHROME_SESSION_PROTOCOL;
  readonly workspaceId: string;
  readonly requestPipePath: string;
  readonly responsePipePath: string;
  readonly clientModulePath: string;
  readonly targetUrl: string;
  readonly expiresAt: number;
}
