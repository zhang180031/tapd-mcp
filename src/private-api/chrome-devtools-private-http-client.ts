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
import {
  PrivateHttpClient,
  TAPD_WEB_ORIGIN,
  readEditorImagePath,
  type PrivateHttpClientOptions,
  type PrivateHttpResult,
  type PrivateRequest,
  type PrivateRequestSession,
  type PrivateSessionProvider,
} from "./private-http-client.js";
import type { ChromePageExecutor } from "../session/chrome-devtools-client.js";
import { TapdSessionManager } from "../session/session-manager.js";

/**
 * A drop-in private client whose requests run in the existing TAPD Chrome
 * page. It does not obtain, retain, or forward browser Cookies/dsc_token.
 */
export class ChromeDevToolsPrivateHttpClient extends PrivateHttpClient {
  private readonly browserTimeoutMs: number;
  private readonly browserMinimumRequestIntervalMs: number;
  private browserNextRequestAt = 0;

  constructor(
    private readonly browserSessions: TapdSessionManager,
    private readonly browser: ChromePageExecutor,
    options: PrivateHttpClientOptions = {},
  ) {
    super(unusableDirectSessionProvider(), fetch, options);
    this.browserTimeoutMs = positiveDuration(options.timeoutMs, 15_000);
    const maxRequestsPerMinute = positiveDuration(options.maxRequestsPerMinute, 60);
    this.browserMinimumRequestIntervalMs = Math.ceil(60_000 / maxRequestsPerMinute);
  }

  override get<T>(request: Omit<PrivateRequest<T>, "method" | "kind">): Promise<PrivateHttpResult<T>> {
    return this.requestThroughChrome({ ...request, method: "GET", kind: "read" });
  }

  override post<T>(request: Omit<PrivateRequest<T>, "method" | "kind"> & { kind?: "read" | "write" }): Promise<PrivateHttpResult<T>> {
    return this.requestThroughChrome({ ...request, method: "POST", kind: request.kind ?? "write" });
  }

  override async uploadEditorImage(input: {
    workspaceId: string;
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  }): Promise<PrivateHttpResult<string>> {
    const workspaceId = requireNumericId(input.workspaceId, "workspace_id");
    this.browserSessions.requireChromeDevToolsContext(workspaceId);
    const url = new URL("https://tdl.tapd.cn/tbl/apis/qmeditor_upload.php");
    url.search = new URLSearchParams({
      "1": "1",
      show_relative_path: "1",
      relative_base_path: "/tfl/",
      image_prefix: `tapd_${workspaceId}_`,
      is_standard_api: "1",
    }).toString();
    await this.waitForBrowserRateLimitSlot();
    let response: { status: number; contentType?: string; requestId?: string; text: string };
    try {
      response = await withTimeout(
        this.browser.request({
          workspaceId,
          method: "POST",
          url: url.toString(),
          upload: { mimeType: input.mimeType, base64: Buffer.from(input.bytes).toString("base64") },
        }),
        this.browserTimeoutMs,
      );
    } catch (error) {
      if (error instanceof TapdPrivateError && error.code === "SESSION_EXPIRED") {
        this.markBrowserExpired(workspaceId, error.message);
        throw error;
      }
      throw new WriteOutcomeUnknownError("editor_image.upload", "network");
    }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      this.markBrowserExpired(workspaceId, "TAPD rejected the image upload session.");
      throw new SessionExpiredError(workspaceId);
    }
    if (response.status >= 500) throw new WriteOutcomeUnknownError("editor_image.upload", "server_error", response.status);
    let payload: unknown;
    try { payload = JSON.parse(response.text); } catch {
      throw new WriteOutcomeUnknownError("editor_image.upload", "invalid_response", response.status);
    }
    const failure = inspectRemoteFailure(payload);
    if (failure) {
      if (failure.sessionExpired) {
        this.markBrowserExpired(workspaceId, "TAPD rejected the current browser session.");
        throw new SessionExpiredError(workspaceId);
      }
      throw new TapdRequestError("editor_image.upload", sanitizeDiagnosticText(failure.message), response.status, response.requestId);
    }
    try {
      return { value: readEditorImagePath(payload, workspaceId), requestId: extractRequestId(payload) ?? response.requestId };
    } catch (error) {
      if (error instanceof TapdPrivateError) throw error;
      throw new WriteOutcomeUnknownError("editor_image.upload", "invalid_response", response.status, responseShapeFingerprint(payload));
    }
  }

  private async requestThroughChrome<T>(request: PrivateRequest<T>): Promise<PrivateHttpResult<T>> {
    const workspaceId = requireNumericId(request.workspaceId, "workspace_id");
    const url = new URL(request.path, TAPD_WEB_ORIGIN);
    if (url.origin !== TAPD_WEB_ORIGIN || !url.pathname.startsWith("/api/")) {
      throw new TypeError("Private TAPD requests must target a same-origin /api/ path.");
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value === null ? "" : String(value));
    }
    this.browserSessions.requireChromeDevToolsContext(workspaceId);
    await this.waitForBrowserRateLimitSlot();
    let response: { status: number; contentType?: string; requestId?: string; text: string };
    try {
      response = await withTimeout(
        this.browser.request({
          workspaceId,
          method: request.method,
          url: url.toString(),
          ...(request.method === "POST" ? { jsonBody: request.body ?? {} } : {}),
        }),
        this.browserTimeoutMs,
      );
    } catch (error) {
      if (error instanceof TapdPrivateError && error.code === "SESSION_EXPIRED") {
        this.markBrowserExpired(workspaceId, error.message);
        throw error;
      }
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "network");
      throw new TapdRequestError(request.endpoint, "TAPD browser request failed.");
    }
    return this.processResponse(request, workspaceId, response);
  }

  private processResponse<T>(
    request: PrivateRequest<T>,
    workspaceId: string,
    response: { status: number; contentType?: string; requestId?: string; text: string },
  ): PrivateHttpResult<T> {
    if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403) {
      this.markBrowserExpired(workspaceId, "TAPD rejected the current browser session.");
      throw new SessionExpiredError(workspaceId);
    }
    if (response.status >= 500) {
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "server_error", response.status);
      throw new TapdRequestError(request.endpoint, "TAPD returned a server error.", response.status);
    }
    if (looksLikeLoginHtml(response.text, response.contentType)) {
      this.markBrowserExpired(workspaceId, "TAPD returned an authentication page.");
      throw new SessionExpiredError(workspaceId);
    }
    let payload: unknown;
    try { payload = response.text ? JSON.parse(response.text) : {}; } catch {
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status);
      throw new ContractChangedError(request.endpoint, "JSON response");
    }
    const requestId = extractRequestId(payload) ?? response.requestId;
    const failure = inspectRemoteFailure(payload);
    if (failure) {
      if (failure.sessionExpired) {
        this.markBrowserExpired(workspaceId, "TAPD rejected the current browser session.");
        throw new SessionExpiredError(workspaceId);
      }
      throw new TapdRequestError(request.endpoint, sanitizeDiagnosticText(failure.message), response.status, requestId);
    }
    if (response.status < 200 || response.status >= 300) throw new TapdRequestError(request.endpoint, "TAPD rejected the request.", response.status, requestId);
    try {
      return { value: request.parse(payload), requestId };
    } catch (error) {
      const responseShape = responseShapeFingerprint(payload);
      if (error instanceof TapdPrivateError) {
        if (request.kind === "write" && error.code === "CONTRACT_CHANGED") {
          throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status, responseShape);
        }
        if (request.kind === "read" && error.code === "CONTRACT_CHANGED") {
          const expected = typeof error.details.expected === "string" ? error.details.expected : "endpoint-specific response contract";
          throw new ContractChangedError(request.endpoint, expected, responseShape);
        }
        throw error;
      }
      if (request.kind === "write") throw new WriteOutcomeUnknownError(request.endpoint, "invalid_response", response.status, responseShape);
      throw new ContractChangedError(request.endpoint, "endpoint-specific response contract", responseShape);
    }
  }

  private async waitForBrowserRateLimitSlot(): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.browserNextRequestAt);
    this.browserNextRequestAt = scheduled + this.browserMinimumRequestIntervalMs;
    if (scheduled > now) await new Promise<void>((resolve) => setTimeout(resolve, scheduled - now));
  }

  private markBrowserExpired(workspaceId: string, reason: string): void {
    this.browserSessions.markExpired(workspaceId, reason);
  }
}

function unusableDirectSessionProvider(): PrivateSessionProvider {
  return {
    getRequestContext: (): PrivateRequestSession => { throw new SessionExpiredError("1"); },
    markExpired: () => undefined,
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError("request rate limit must be a positive integer.");
  return resolved;
}

function looksLikeLoginHtml(text: string, contentType: string | undefined): boolean {
  const html = /text\/html/i.test(contentType ?? "") || /^\s*<!doctype html|^\s*<html/i.test(text);
  return html && /(?:login|登录|扫码|account|passport)/i.test(text.slice(0, 8_000));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
