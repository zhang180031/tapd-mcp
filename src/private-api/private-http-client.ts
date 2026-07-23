import {
  ContractChangedError,
  SessionExpiredError,
  TapdPrivateError,
  TapdRequestError,
  WriteOutcomeUnknownError,
  responseShapeFingerprint,
  sanitizeDiagnosticText,
} from "./errors.js";
import { extractRequestId, inspectRemoteFailure, requireNumericId } from "./contracts.js";

export const TAPD_WEB_ORIGIN = "https://www.tapd.cn";

export interface PrivateRequestSession {
  workspaceId: string;
  cookieHeader: string;
  dscToken: string;
}

/** Structurally compatible with TapdSessionManager; secrets never leave this boundary. */
export interface PrivateSessionProvider {
  getRequestContext(workspaceId: string, requestUrl?: string): PrivateRequestSession | Promise<PrivateRequestSession>;
  markExpired(workspaceId: string, reason?: string): void | Promise<void>;
  mergeSetCookieHeaders?(workspaceId: string, headers: readonly string[], requestUrl?: string): void | Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type RequestKind = "read" | "write";

export interface PrivateRequest<T> {
  workspaceId: string;
  endpoint: string;
  method: "GET" | "POST";
  path: string;
  kind: RequestKind;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  body?: Readonly<Record<string, unknown>>;
  parse(payload: unknown): T;
}

export interface PrivateHttpResult<T> {
  value: T;
  requestId?: string;
}

export interface PrivateHttpClientOptions {
  timeoutMs?: number;
  maxRequestsPerMinute?: number;
}

export class PrivateHttpClient {
  private readonly timeoutMs: number;
  private readonly minimumRequestIntervalMs: number;
  private nextRequestAt = 0;

  constructor(
    private readonly sessions: PrivateSessionProvider,
    private readonly fetchImpl: FetchLike = fetch,
    options: PrivateHttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive integer.");
    }
    const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 60;
    if (!Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
      throw new TypeError("maxRequestsPerMinute must be a positive integer.");
    }
    this.minimumRequestIntervalMs = Math.ceil(60_000 / maxRequestsPerMinute);
  }

  get<T>(request: Omit<PrivateRequest<T>, "method" | "kind">): Promise<PrivateHttpResult<T>> {
    return this.request({ ...request, method: "GET", kind: "read" });
  }

  post<T>(request: Omit<PrivateRequest<T>, "method" | "kind"> & { kind?: RequestKind }): Promise<PrivateHttpResult<T>> {
    return this.request({ ...request, method: "POST", kind: request.kind ?? "write" });
  }

  async uploadEditorImage(input: {
    workspaceId: string;
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  }): Promise<PrivateHttpResult<string>> {
    const workspaceId = requireNumericId(input.workspaceId, "workspace_id");
    const url = new URL("https://tdl.tapd.cn/tbl/apis/qmeditor_upload.php");
    url.search = new URLSearchParams({
      "1": "1",
      show_relative_path: "1",
      relative_base_path: "/tfl/",
      image_prefix: `tapd_${workspaceId}_`,
      is_standard_api: "1",
    }).toString();
    // Verify that a valid www.tapd.cn session exists, but never forward its
    // host-scoped cookies to the separate upload subdomain.
    const session = await this.sessions.getRequestContext(workspaceId);
    if (!session.cookieHeader || session.workspaceId !== workspaceId) throw new SessionExpiredError(workspaceId);
    await this.waitForRateLimitSlot();

    const form = new FormData();
    form.set("from", "snapscreen");
    form.set("base64", "true");
    form.set("content", `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          referer: `${TAPD_WEB_ORIGIN}/`,
        },
        body: form,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new WriteOutcomeUnknownError("editor_image.upload", isAbortError(error) ? "timeout" : "network");
    }
    clearTimeout(timer);
    await this.mergeResponseCookies(workspaceId, response, url);
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      await this.expire(workspaceId, "TAPD rejected the image upload session.");
      throw new SessionExpiredError(workspaceId);
    }
    if (!response.ok) throw new WriteOutcomeUnknownError("editor_image.upload", "server_error", response.status);
    let payload: unknown;
    try { payload = JSON.parse(await response.text()); } catch {
      throw new WriteOutcomeUnknownError("editor_image.upload", "invalid_response", response.status);
    }
    const path = readEditorImagePath(payload, workspaceId);
    return { value: path, requestId: extractRequestId(payload) };
  }

  async request<T>(request: PrivateRequest<T>): Promise<PrivateHttpResult<T>> {
    const workspaceId = requireNumericId(request.workspaceId, "workspace_id");
    const url = this.resolveUrl(request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value === null ? "" : String(value));
    }

    let session: PrivateRequestSession;
    try {
      session = await this.sessions.getRequestContext(workspaceId, url.toString());
    } catch (error) {
      if (error instanceof TapdPrivateError && error.code === "SESSION_EXPIRED") throw error;
      throw new SessionExpiredError(workspaceId);
    }
    if (!session.cookieHeader || !session.dscToken || session.workspaceId !== workspaceId) {
      throw new SessionExpiredError(workspaceId);
    }

    await this.waitForRateLimitSlot();

    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      cookie: session.cookieHeader,
      origin: TAPD_WEB_ORIGIN,
      referer: refererFor(workspaceId, request.endpoint),
      "x-requested-with": "XMLHttpRequest",
    };
    let body: string | undefined;
    if (request.method !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...(request.body ?? {}), dsc_token: session.dscToken });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (request.kind === "write") {
        throw new WriteOutcomeUnknownError(request.endpoint, isAbortError(error) ? "timeout" : "network");
      }
      throw new TapdRequestError(request.endpoint, isAbortError(error) ? "TAPD request timed out." : "TAPD network request failed.");
    }

    await this.mergeResponseCookies(workspaceId, response, url);

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      await this.expire(workspaceId, "TAPD redirected the request to an authentication page.");
      throw new SessionExpiredError(workspaceId);
    }
    if (response.status === 401 || response.status === 403) {
      clearTimeout(timer);
      await this.expire(workspaceId, "TAPD rejected the current login session.");
      throw new SessionExpiredError(workspaceId);
    }
    if (response.status >= 500) {
      clearTimeout(timer);
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "server_error", response.status);
      throw new TapdRequestError(request.endpoint, "TAPD returned a server error.", response.status);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "network", response.status);
      throw new TapdRequestError(request.endpoint, "The TAPD response could not be read.", response.status);
    }
    clearTimeout(timer);
    if (looksLikeLoginHtml(text, response.headers.get("content-type"))) {
      await this.expire(workspaceId, "TAPD returned an authentication page.");
      throw new SessionExpiredError(workspaceId);
    }

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status);
      throw new ContractChangedError(request.endpoint, "JSON response");
    }

    const requestId = extractRequestId(payload) ?? safeRequestId(response.headers.get("x-request-id"));
    const failure = inspectRemoteFailure(payload);
    if (failure) {
      if (failure.sessionExpired) {
        await this.expire(workspaceId, "TAPD rejected the current session token.");
        throw new SessionExpiredError(workspaceId);
      }
      throw new TapdRequestError(request.endpoint, sanitizeDiagnosticText(failure.message), response.status, requestId);
    }
    if (!response.ok) throw new TapdRequestError(request.endpoint, "TAPD rejected the request.", response.status, requestId);

    try {
      return { value: request.parse(payload), requestId };
    } catch (error) {
      const responseShape = responseShapeFingerprint(payload);
      if (error instanceof TapdPrivateError) {
        if (request.kind === "write" && error.code === "CONTRACT_CHANGED") {
          throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status, responseShape);
        }
        if (request.kind === "read" && error.code === "CONTRACT_CHANGED") {
          const expected = typeof error.details.expected === "string"
            ? error.details.expected
            : "endpoint-specific response contract";
          throw new ContractChangedError(request.endpoint, expected, responseShape);
        }
        throw error;
      }
      if (request.kind === "write") {
        throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status, responseShape);
      }
      throw new ContractChangedError(request.endpoint, "endpoint-specific response contract", responseShape);
    }
  }

  private resolveUrl(path: string): URL {
    const url = new URL(path, TAPD_WEB_ORIGIN);
    if (url.origin !== TAPD_WEB_ORIGIN || !url.pathname.startsWith("/api/")) {
      throw new TypeError("Private TAPD requests must target a same-origin /api/ path.");
    }
    return url;
  }

  private async waitForRateLimitSlot(): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduled + this.minimumRequestIntervalMs;
    if (scheduled > now) {
      await new Promise<void>((resolve) => setTimeout(resolve, scheduled - now));
    }
  }

  private async expire(workspaceId: string, reason: string): Promise<void> {
    try { await this.sessions.markExpired(workspaceId, reason); } catch { /* preserve the primary safe error */ }
  }

  private async mergeResponseCookies(workspaceId: string, response: Response, url: URL): Promise<void> {
    if (!this.sessions.mergeSetCookieHeaders) return;
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    if (!values.length) return;
    try { await this.sessions.mergeSetCookieHeaders(workspaceId, values, url.toString()); } catch { /* cookie rotation is best effort */ }
  }
}

export function readEditorImagePath(payload: unknown, workspaceId: string): string {
  if (!payload || typeof payload !== "object") throw new ContractChangedError("editor_image.upload", "data.file_path");
  const data = (payload as { data?: unknown }).data;
  const path = data && typeof data === "object" ? (data as { file_path?: unknown }).file_path : undefined;
  const pattern = new RegExp(`^/tfl/captures/\\d{4}-\\d{2}/tapd_${workspaceId}_[A-Za-z0-9._-]+\\.(?:png|jpe?g|gif|webp)$`, "i");
  if (typeof path !== "string" || !pattern.test(path)) {
    throw new ContractChangedError("editor_image.upload", "workspace-scoped /tfl/captures image path");
  }
  return path;
}

function looksLikeLoginHtml(text: string, contentType: string | null): boolean {
  const html = /text\/html/i.test(contentType ?? "") || /^\s*<!doctype html|^\s*<html/i.test(text);
  return html && /(?:login|登录|扫码|account|passport)/i.test(text.slice(0, 8_000));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function refererFor(workspaceId: string, endpoint: string): string {
  const route = /bug/i.test(endpoint) ? "bug/list?useScene=bugList" : "story/list?useScene=storyList";
  return `${TAPD_WEB_ORIGIN}/tapd_fe/${encodeURIComponent(workspaceId)}/${route}`;
}
