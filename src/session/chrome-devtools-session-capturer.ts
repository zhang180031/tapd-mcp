import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ChromeDevToolsUnavailableError } from "./chrome-devtools-client.js";
import type { TapdCookieInput } from "./cookie-jar.js";
import type { TapdEntitySessionContext } from "./types.js";

const TAPD_ORIGIN = "https://www.tapd.cn";
const MAX_COOKIE_COUNT = 128;

export interface ChromeSessionCapturer {
  captureWorkspace(workspaceId: string): Promise<ChromeWorkspaceSessionCapture>;
  close(): Promise<void>;
}

export interface ChromeDevToolsSessionCapturerOptions {
  userDataDir?: string;
  requestTimeoutMs?: number;
}

/**
 * Performs one explicit Chrome DevTools capture at login-refresh time. It uses
 * CDP's cookie domain so HttpOnly TAPD cookies can be handed to the local
 * session store without exposing them through page JavaScript or MCP output.
 */
export class ChromeDevToolsSessionCapturer implements ChromeSessionCapturer {
  private readonly userDataDir: string;
  private readonly requestTimeoutMs: number;

  constructor(options: ChromeDevToolsSessionCapturerOptions = {}) {
    this.userDataDir = options.userDataDir ?? defaultChromeUserDataDir();
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, 20_000);
  }

  async captureWorkspace(workspaceId: string): Promise<ChromeWorkspaceSessionCapture> {
    const id = requireWorkspaceId(workspaceId);
    const connection = await CdpConnection.open(browserWebSocketEndpoint(this.userDataDir), this.requestTimeoutMs);
    let sessionId: string | undefined;
    try {
      const page = await findTapdPageForSessionCapture(connection, id);
      const attached = await connection.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      sessionId = stringField(attached, "sessionId");
      if (!sessionId) throw unavailable("Chrome DevTools did not attach to the TAPD page.");

      const [cookiesResult, tokenResult] = await Promise.all([
        connection.send("Network.getCookies", { urls: [TAPD_ORIGIN] }, sessionId),
        connection.send("Runtime.evaluate", { expression: dscTokenExpression(), returnByValue: true }, sessionId),
      ]);
      const cookies = parseTapdCookies(cookiesResult);
      const dscToken = runtimeString(tokenResult);
      if (!cookies.length || !dscToken) {
        throw unavailable("The open TAPD page is not authenticated. Sign in in that same Chrome tab and refresh the TAPD session.");
      }
      // TAPD's web session is account-scoped rather than workspace-scoped.
      // A logged-in work-item page from another accessible workspace is enough
      // to refresh credentials, but its list metadata must never be reused for
      // the requested workspace.
      const context = page.workspaceMatched ? contextFromPageUrl(page.url) : { confId: "" };
      return {
        workspaceId: id,
        cookies,
        dscToken,
        storyContext: context,
        bugContext: context,
      };
    } finally {
      if (sessionId) await connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      connection.close();
    }
  }

  async close(): Promise<void> {
    // Each capture opens and closes its own CDP socket, so no browser control
    // remains attached after the one-time session handoff.
  }
}

/** Internal bridge shape: raw cookie values never cross an MCP result. */
export interface ChromeWorkspaceSessionCapture {
  readonly workspaceId: string;
  readonly cookies: readonly TapdCookieInput[];
  readonly dscToken: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener("message", (event: { data: unknown }) => this.handleMessage(event.data));
    socket.addEventListener("error", () => this.rejectAll(unavailable("Chrome DevTools connection failed.")));
    socket.addEventListener("close", () => this.rejectAll(unavailable("Chrome DevTools connection closed.")));
  }

  static async open(endpoint: string, timeoutMs: number): Promise<CdpConnection> {
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpoint);
    } catch {
      throw unavailable("Chrome DevTools could not open a connection.");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable("Chrome DevTools did not respond in time.")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(unavailable("Chrome DevTools could not connect."));
      }, { once: true });
    });
    return new CdpConnection(socket, timeoutMs);
  }

  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable("Chrome DevTools did not respond in time."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(payload);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(unavailable("Chrome DevTools could not send a request."));
      }
    });
  }

  close(): void {
    this.socket.close();
    this.rejectAll(unavailable("Chrome DevTools connection closed."));
  }

  private handleMessage(data: unknown): void {
    const text = messageText(data);
    if (!text) return;
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(unavailable("Chrome DevTools rejected the browser operation."));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface TapdPageForSessionCapture {
  readonly targetId: string;
  readonly url: string;
  readonly workspaceMatched: boolean;
}

/**
 * Select a logged-in TAPD work-item page for the one-time credential handoff.
 * Prefer the requested workspace to preserve its list context; otherwise use
 * another open TAPD work-item page without importing its workspace metadata.
 */
export function selectTapdPageForSessionCapture(targets: unknown, workspaceId: string): TapdPageForSessionCapture | undefined {
  const id = requireWorkspaceId(workspaceId);
  const source = Array.isArray(targets) ? targets : [];
  let fallback: TapdPageForSessionCapture | undefined;
  for (const target of source) {
    if (!isRecord(target) || target.type !== "page" || typeof target.targetId !== "string" || typeof target.url !== "string") continue;
    const pageWorkspaceId = tapdWorkItemWorkspaceId(target.url);
    if (!pageWorkspaceId) continue;
    const candidate = { targetId: target.targetId, url: target.url, workspaceMatched: pageWorkspaceId === id };
    if (candidate.workspaceMatched) return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

async function findTapdPageForSessionCapture(connection: CdpConnection, workspaceId: string): Promise<TapdPageForSessionCapture> {
  const response = await connection.send("Target.getTargets", {});
  const targets = isRecord(response) && Array.isArray(response.targetInfos) ? response.targetInfos : [];
  const page = selectTapdPageForSessionCapture(targets, workspaceId);
  if (page) return page;
  throw unavailable("No open TAPD story or Bug page was found in Chrome. Open any logged-in TAPD work-item page and refresh the TAPD session.");
}

function parseTapdCookies(value: unknown): TapdCookieInput[] {
  const source = isRecord(value) && Array.isArray(value.cookies) ? value.cookies : [];
  if (source.length === 0 || source.length > MAX_COOKIE_COUNT) return [];
  const cookies: TapdCookieInput[] = [];
  for (const rawCookie of source) {
    if (!isRecord(rawCookie) || !validCookieText(rawCookie.name, 256) || !validCookieText(rawCookie.value, 16_384)) return [];
    const domain = typeof rawCookie.domain === "string" ? rawCookie.domain.trim().toLowerCase() : "";
    const normalisedDomain = domain.replace(/^\.+/, "");
    if (normalisedDomain !== "tapd.cn" && !normalisedDomain.endsWith(".tapd.cn")) continue;
    const path = typeof rawCookie.path === "string" && rawCookie.path.startsWith("/") ? rawCookie.path : "/";
    cookies.push({
      name: rawCookie.name,
      value: rawCookie.value,
      domain,
      path,
      expires: typeof rawCookie.expires === "number" && Number.isFinite(rawCookie.expires) ? rawCookie.expires : undefined,
      httpOnly: rawCookie.httpOnly === true,
      secure: rawCookie.secure === true,
      sameSite: typeof rawCookie.sameSite === "string" ? rawCookie.sameSite : undefined,
    });
  }
  return cookies;
}

function runtimeString(value: unknown): string | undefined {
  const result = isRecord(value) && isRecord(value.result) ? value.result : undefined;
  const token = result && typeof result.value === "string" ? result.value.trim() : "";
  return token && !/[\u0000\r\n]/.test(token) && token.length <= 16_384 ? token : undefined;
}

function dscTokenExpression(): string {
  return `(() => { const prefix = "dsc-token="; for (const part of document.cookie.split(";")) { const value = part.trim(); if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length)); } return ""; })()`;
}

function browserWebSocketEndpoint(userDataDir: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8");
  } catch {
    throw unavailable(`Could not find DevToolsActivePort for Chrome at ${join(userDataDir, "DevToolsActivePort")}.`);
  }
  const [portText, path] = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 || !path?.startsWith("/")) {
    throw unavailable("Chrome DevTools returned an invalid DevToolsActivePort file.");
  }
  return `ws://127.0.0.1:${port}${path}`;
}

function defaultChromeUserDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-chrome");
}

function contextFromPageUrl(raw: string): TapdEntitySessionContext | undefined {
  try {
    const confId = new URL(raw).searchParams.get("conf_id")?.trim();
    // TAPD's default Story/Bug list omits conf_id. An explicit empty value is
    // meaningful to the aggregation endpoints and must be retained as list
    // context rather than treated as a missing capture.
    if (!confId) return { confId: "" };
    return /^[1-9]\d*$/.test(confId) ? { confId } : undefined;
  } catch {
    return undefined;
  }
}

function tapdWorkItemWorkspaceId(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.origin !== TAPD_ORIGIN) return undefined;
    const match = /^\/tapd_fe\/([1-9]\d*)\/(?:story|bug)\//.exec(url.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  return undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function validCookieText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000\r\n]/.test(value);
}

function requireWorkspaceId(value: string): string {
  const id = value.trim();
  if (!/^[1-9]\d*$/.test(id)) throw unavailable("workspace_id must be a positive numeric string.");
  return id;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError("requestTimeoutMs must be a positive integer.");
  return resolved;
}

function unavailable(message: string): ChromeDevToolsUnavailableError {
  return new ChromeDevToolsUnavailableError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
