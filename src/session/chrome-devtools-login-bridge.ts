import type { ChromeLoginBridge, ChromeLoginBridgeStatus } from "./chrome-login-bridge.js";
import { SafeCookieJar } from "./cookie-jar.js";
import type { ChromeSessionCapturer } from "./chrome-devtools-session-capturer.js";
import { ChromeLoginBridgeError, ChromeLoginBridgeStateError } from "./errors.js";
import { TapdSessionManager } from "./session-manager.js";

export interface ChromeDevToolsLoginBridgeOptions {
  sessionManager: TapdSessionManager;
  browser: ChromeSessionCapturer;
}

/**
 * Refreshes TAPD availability by validating the user's existing Chrome tab.
 * Unlike the retired Chrome-controller bridge, it stores only list metadata;
 * all authenticated calls subsequently remain inside that browser page.
 */
export class ChromeDevToolsLoginBridge implements ChromeLoginBridge {
  private activeWorkspaceId?: string;

  constructor(
    private readonly options: ChromeDevToolsLoginBridgeOptions,
  ) {}

  async begin(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    const id = requireWorkspaceId(workspaceId);
    if (this.activeWorkspaceId && this.activeWorkspaceId !== id) {
      throw new ChromeLoginBridgeStateError(
        `A Chrome DevTools refresh is already waiting for workspace_id ${this.activeWorkspaceId}. Cancel it first.`,
      );
    }
    this.options.sessionManager.beginLogin(id);
    this.activeWorkspaceId = id;
    return this.status(id);
  }

  async complete(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    const id = requireWorkspaceId(workspaceId);
    if (this.activeWorkspaceId !== id) {
      throw new ChromeLoginBridgeStateError(`No Chrome DevTools refresh is waiting for workspace_id ${id}.`);
    }
    try {
      const capture = await this.options.browser.captureWorkspace(id);
      this.options.sessionManager.completeLogin(id, {
        workspaceId: capture.workspaceId,
        cookieJar: SafeCookieJar.fromCookies(capture.cookies),
        dscToken: capture.dscToken,
        storyContext: capture.storyContext,
        bugContext: capture.bugContext,
      });
      this.activeWorkspaceId = undefined;
      return this.status(id);
    } catch (error) {
      // Preserve the explicit refresh state so the caller can retry `complete`
      // after repairing Chrome's DevTools connection or signing in.
      throw error instanceof Error
        ? error
        : new ChromeLoginBridgeError("Could not validate the existing TAPD Chrome tab.");
    }
  }

  async cancel(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    const id = requireWorkspaceId(workspaceId);
    if (this.activeWorkspaceId && this.activeWorkspaceId !== id) {
      throw new ChromeLoginBridgeStateError(
        `The pending Chrome DevTools refresh belongs to workspace_id ${this.activeWorkspaceId}, not ${id}.`,
      );
    }
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = undefined;
    this.options.sessionManager.cancelLogin(id);
    return this.status(id);
  }

  getStatus(workspaceId: string): ChromeLoginBridgeStatus {
    return this.status(requireWorkspaceId(workspaceId));
  }

  async close(): Promise<void> {
    const active = this.activeWorkspaceId;
    this.activeWorkspaceId = undefined;
    if (active) this.options.sessionManager.cancelLogin(active);
    await this.options.browser.close();
  }

  private status(workspaceId: string): ChromeLoginBridgeStatus {
    return {
      workspaceId,
      state: this.options.sessionManager.getState(workspaceId),
      pageOpen: this.activeWorkspaceId === workspaceId,
      cleanupPending: this.activeWorkspaceId === workspaceId,
      browserMode: "chrome_devtools",
      captureReceived: false,
    };
  }
}

function requireWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!/^[1-9]\d*$/.test(workspaceId)) throw new ChromeLoginBridgeError("workspace_id must be a positive numeric string.");
  return workspaceId;
}
