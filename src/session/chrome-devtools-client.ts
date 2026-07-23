import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { TapdPrivateError } from "../private-api/errors.js";
import type { TapdEntitySessionContext } from "./types.js";

const TAPD_ORIGIN = "https://www.tapd.cn";
const MAX_RESPONSE_CHARS = 2_000_000;
const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface ChromeDevToolsClientOptions {
  command?: string;
  args?: readonly string[];
  requestTimeoutMs?: number;
}

export interface ChromeWorkspaceCapture {
  readonly workspaceId: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
}

export interface ChromePageRequest {
  readonly workspaceId: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly jsonBody?: Readonly<Record<string, unknown>>;
  readonly upload?: {
    readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    readonly base64: string;
  };
}

export interface ChromePageResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly requestId?: string;
  readonly text: string;
}

export interface ChromePageExecutor {
  captureWorkspace(workspaceId: string): Promise<ChromeWorkspaceCapture>;
  request(request: ChromePageRequest): Promise<ChromePageResponse>;
  close(): Promise<void>;
}

/**
 * Minimal MCP client for the Chrome DevTools connector. The connector handles
 * Chrome's current DevTools transport; this process only asks it to evaluate a
 * request in an existing TAPD page. Browser Cookie/CSRF values never enter
 * this process or a tool result.
 */
export class ChromeDevToolsClient implements ChromePageExecutor {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly requestTimeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextMessageId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: ChromeDevToolsClientOptions = {}) {
    this.command = options.command ?? "npx";
    this.args = options.args ?? ["-y", "chrome-devtools-mcp@latest", "--autoConnect"];
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, 20_000);
  }

  async captureWorkspace(workspaceId: string): Promise<ChromeWorkspaceCapture> {
    const page = await this.findWorkspacePage(workspaceId);
    await this.selectPage(page.id);
    const context = contextFromPageUrl(page.url);
    return {
      workspaceId,
      // TAPD exposes one list route per tab. Reuse its discovered conf_id as a
      // workspace-scoped initial hint; the query token remains intentionally
      // absent until a verified list response establishes it.
      storyContext: context,
      bugContext: context,
    };
  }

  async request(input: ChromePageRequest): Promise<ChromePageResponse> {
    validatePageRequest(input);
    const page = await this.findWorkspacePage(input.workspaceId);
    await this.selectPage(page.id);
    const output = await this.callTool("evaluate_script", { function: pageFetchExpression(input) });
    return parsePageResponse(parseToolJson(output));
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    if (child && !child.killed) child.kill();
    this.rejectPending(new ChromeDevToolsUnavailableError("The Chrome DevTools connection closed."));
  }

  private async findWorkspacePage(workspaceId: string): Promise<{ id: number; url: string }> {
    const text = await this.callTool("list_pages", {});
    const expected = new RegExp(`^\\s*(\\d+):.*\\((https://www\\.tapd\\.cn/tapd_fe/${escapeRegex(workspaceId)}/(?:story|bug)/[^)]*)\\)`, "m");
    const match = text.match(expected);
    if (!match) {
      throw new ChromeDevToolsUnavailableError(
        `No open TAPD browser page was found for workspace_id ${workspaceId}. Open that workspace in Chrome and refresh the TAPD session.`,
      );
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 0) throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an invalid TAPD page id.");
    return { id, url: match[2] };
  }

  private async selectPage(pageId: number): Promise<void> {
    await this.callTool("select_page", { pageId });
  }

  private async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const result = await this.call("tools/call", { name, arguments: arguments_ });
    const record = objectValue(result);
    if (!record || record.isError === true) throw new ChromeDevToolsUnavailableError("Chrome DevTools could not complete the browser operation.");
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
      .map((entry) => objectValue(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text as string)
      .join("\n");
    if (!text) throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an empty browser response.");
    return text;
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    return this.requestRaw(method, params);
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (!this.starting) this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      throw new ChromeDevToolsUnavailableError("Chrome DevTools could not be started.");
    }
    this.child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.onStdout(String(chunk)));
    child.on("error", () => this.onChildStopped());
    child.on("exit", () => this.onChildStopped());
    try {
      await this.requestRaw("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "tapd-mcp-chrome-bridge", version: "0.4.0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private requestRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new ChromeDevToolsUnavailableError("Chrome DevTools is not connected.");
    }
    const id = this.nextMessageId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChromeDevToolsUnavailableError("Chrome DevTools did not respond in time."));
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        child.stdin.write(`${message}\n`);
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new ChromeDevToolsUnavailableError("Chrome DevTools could not send the browser request."));
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      const record = objectValue(message);
      const id = typeof record?.id === "number" ? record.id : undefined;
      if (id === undefined) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (record?.error) {
        pending.reject(new ChromeDevToolsUnavailableError("Chrome DevTools rejected the browser operation."));
      } else {
        pending.resolve(record?.result ?? {});
      }
    }
  }

  private onChildStopped(): void {
    this.child = undefined;
    this.rejectPending(new ChromeDevToolsUnavailableError("Chrome DevTools connection closed."));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class ChromeDevToolsUnavailableError extends TapdPrivateError {
  override readonly name = "ChromeDevToolsUnavailableError";

  constructor(message: string) {
    super("SESSION_EXPIRED", message);
  }
}

function pageFetchExpression(input: ChromePageRequest): string {
  const serialized = JSON.stringify(input).replace(/</g, "\\u003c");
  return `async () => {
    const input = ${serialized};
    const readCookie = (name) => {
      const prefix = name + "=";
      for (const part of document.cookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
      }
      return "";
    };
    const dscToken = readCookie("dsc-token");
    if (!dscToken) return { failure: "missing_dsc_token" };
    let body;
    // x-requested-with is required by the www.tapd.cn JSON APIs but causes
    // a cross-origin preflight that the editor upload host rejects.
    const headers = input.upload
      ? { accept: "application/json, text/plain, */*" }
      : { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" };
    if (input.jsonBody) {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...input.jsonBody, dsc_token: dscToken });
    } else if (input.upload) {
      const form = new FormData();
      form.set("from", "snapscreen");
      form.set("base64", "true");
      form.set("content", "data:" + input.upload.mimeType + ";base64," + input.upload.base64);
      body = form;
    }
    try {
      const response = await fetch(input.url, { method: input.method, headers, body, credentials: "include", redirect: "manual" });
      const text = await response.text();
      if (text.length > ${MAX_RESPONSE_CHARS}) return { failure: "response_too_large", status: response.status };
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || undefined,
        requestId: response.headers.get("x-request-id") || undefined,
        text,
      };
    } catch {
      return { failure: "network" };
    }
  }`;
}

function parseToolJson(text: string): unknown {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (!match) throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an invalid script result.");
  try { return JSON.parse(match[1]); } catch {
    throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an invalid script result.");
  }
}

function parsePageResponse(value: unknown): ChromePageResponse {
  const record = objectValue(value);
  if (!record) throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an invalid TAPD page response.");
  if (record.failure === "missing_dsc_token") {
    throw new ChromeDevToolsUnavailableError("The open TAPD page is not authenticated. Sign in in that same Chrome tab and refresh the TAPD session.");
  }
  if (record.failure === "network") throw new ChromeDevToolsUnavailableError("The TAPD browser request could not be completed.");
  if (record.failure === "response_too_large") throw new ChromeDevToolsUnavailableError("The TAPD browser response exceeded the safe size limit.");
  const status = record.status;
  const text = record.text;
  if (!Number.isInteger(status) || typeof text !== "string") {
    throw new ChromeDevToolsUnavailableError("Chrome DevTools returned an invalid TAPD page response.");
  }
  return {
    status: status as number,
    text,
    contentType: typeof record.contentType === "string" ? record.contentType : undefined,
    requestId: safeRequestId(typeof record.requestId === "string" ? record.requestId : undefined),
  };
}

function contextFromPageUrl(raw: string): TapdEntitySessionContext | undefined {
  try {
    const url = new URL(raw);
    const confId = url.searchParams.get("conf_id")?.trim();
    if (confId && /^[1-9]\d*$/.test(confId)) return { confId };
  } catch { /* the page URL was constrained by findWorkspacePage */ }
  return undefined;
}

function validatePageRequest(input: ChromePageRequest): void {
  const workspaceId = input.workspaceId.trim();
  if (!/^[1-9]\d*$/.test(workspaceId)) throw new TypeError("workspaceId must be numeric.");
  const url = new URL(input.url);
  const allowedUpload = url.origin === "https://tdl.tapd.cn" && url.pathname === "/tbl/apis/qmeditor_upload.php";
  if ((url.origin !== TAPD_ORIGIN || !url.pathname.startsWith("/api/")) && !allowedUpload) {
    throw new TypeError("Chrome TAPD requests must use an approved TAPD endpoint.");
  }
  if (input.upload && (input.method !== "POST" || input.jsonBody)) throw new TypeError("Image upload requires a POST body.");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeRequestId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError("requestTimeoutMs must be a positive integer.");
  return resolved;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
