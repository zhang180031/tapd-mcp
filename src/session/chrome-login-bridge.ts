import type { TapdSessionState } from "./types.js";
import type { ExistingChromeSessionHandoff } from "./existing-chrome-session-protocol.js";

export interface ChromeLoginBridgeStatus {
  readonly workspaceId: string;
  readonly state: TapdSessionState;
  readonly pageOpen: boolean;
  readonly cleanupPending: boolean;
  readonly browserMode?: "existing_chrome" | "chrome_devtools";
  readonly captureReceived?: boolean;
  readonly loginUrl?: string;
  readonly handoff?: ExistingChromeSessionHandoff;
}

/** Explicit two-call handoff: begin prepares a private receiver; complete accepts the existing Chrome capture. */
export interface ChromeLoginBridge {
  begin(workspaceId: string): Promise<ChromeLoginBridgeStatus>;
  complete(workspaceId: string): Promise<ChromeLoginBridgeStatus>;
  cancel(workspaceId: string): Promise<ChromeLoginBridgeStatus>;
  close(): Promise<void>;
  getStatus(workspaceId: string): ChromeLoginBridgeStatus;
}
