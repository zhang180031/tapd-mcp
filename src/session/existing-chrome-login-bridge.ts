import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SafeCookieJar, type TapdCookieInput } from "./cookie-jar.js";
import type { ChromeLoginBridge, ChromeLoginBridgeStatus } from "./chrome-login-bridge.js";
import { ChromeLoginBridgeError, ChromeLoginBridgeStateError } from "./errors.js";
import {
  EXISTING_CHROME_HANDOFF_PREFIX,
  EXISTING_CHROME_REQUEST_PIPE_NAME,
  EXISTING_CHROME_RESPONSE_PIPE_NAME,
  EXISTING_CHROME_SESSION_PROTOCOL,
  MAX_EXISTING_CHROME_HANDOFF_BYTES,
  type ExistingChromeSessionHandoff,
} from "./existing-chrome-session-protocol.js";
import { TapdSessionManager } from "./session-manager.js";
import type { TapdEntitySessionContext, TapdWorkspaceSessionInput } from "./types.js";

const TAPD_HOSTNAME = "www.tapd.cn";
const TAPD_ORIGIN = "https://www.tapd.cn";

export interface ExistingChromeLoginBridgeOptions {
  sessionManager: TapdSessionManager;
  loginTimeoutMs?: number;
  clock?: () => number;
  tempRoot?: string;
  clientModulePath?: string;
  loginUrlFactory?: (workspaceId: string) => string;
  mkfifoExecutablePath?: string;
}

interface ActiveHandoff {
  readonly workspaceId: string;
  readonly directoryPath: string;
  readonly requestPipePath: string;
  readonly responsePipePath: string;
  readonly requestFd: number;
  readonly responseFd: number;
  readonly targetUrl: string;
  readonly clientModulePath: string;
  readonly expiresAt: number;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  readonly pollHandle: ReturnType<typeof setInterval>;
  readonly chunks: Buffer[];
  byteLength: number;
  pipesClosed: boolean;
  finished: boolean;
  capture?: TapdWorkspaceSessionInput;
  failure?: ChromeLoginBridgeError;
}

/**
 * Memory-only handoff for a TAPD session captured from the user's existing
 * Chrome tab. This class never launches Chrome and never reads Chrome files.
 */
export class ExistingChromeLoginBridge implements ChromeLoginBridge {
  private readonly sessionManager: TapdSessionManager;
  private readonly loginTimeoutMs: number;
  private readonly clock: () => number;
  private readonly tempRoot: string;
  private readonly clientModulePath: string;
  private readonly loginUrlFactory: (workspaceId: string) => string;
  private readonly mkfifoExecutablePath: string;
  private active?: ActiveHandoff;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ExistingChromeLoginBridgeOptions) {
    this.sessionManager = options.sessionManager;
    this.loginTimeoutMs = positiveDuration(options.loginTimeoutMs, 180_000, "loginTimeoutMs");
    this.clock = options.clock ?? Date.now;
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.clientModulePath = options.clientModulePath
      ?? fileURLToPath(new URL("./existing-chrome-session-client.js", import.meta.url));
    this.loginUrlFactory = options.loginUrlFactory ?? defaultLoginUrl;
    this.mkfifoExecutablePath = options.mkfifoExecutablePath ?? findMkfifoExecutable();
  }

  begin(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    return this.exclusive(async () => {
      const id = requireWorkspaceId(workspaceId);
      if (this.active) {
        if (this.active.workspaceId !== id) {
          throw new ChromeLoginBridgeStateError(
            `An existing-Chrome handoff is already waiting for workspace_id ${this.active.workspaceId}. Cancel it first.`,
          );
        }
        return this.status(id);
      }

      this.sessionManager.beginLogin(id);
      let directoryPath: string | undefined;
      let requestFd: number | undefined;
      let responseFd: number | undefined;
      try {
        directoryPath = await mkdtemp(join(this.tempRoot, EXISTING_CHROME_HANDOFF_PREFIX));
        await chmod(directoryPath, 0o700);
        const requestPipePath = join(directoryPath, EXISTING_CHROME_REQUEST_PIPE_NAME);
        const responsePipePath = join(directoryPath, EXISTING_CHROME_RESPONSE_PIPE_NAME);
        await createNamedPipes(this.mkfifoExecutablePath, requestPipePath, responsePipePath);
        await Promise.all([chmod(requestPipePath, 0o600), chmod(responsePipePath, 0o600)]);
        const targetUrl = validateTapdLoginUrl(this.loginUrlFactory(id), id);
        const expiresAt = this.clock() + this.loginTimeoutMs;
        // O_RDWR + O_NONBLOCK keeps both FIFO endpoints open without consuming a
        // libuv thread while no Chrome client is attached.
        requestFd = openSync(requestPipePath, constants.O_RDWR | constants.O_NONBLOCK);
        responseFd = openSync(responsePipePath, constants.O_RDWR | constants.O_NONBLOCK);
        const timeoutHandle = setTimeout(
          () => void this.expireHandoff(id).catch(() => undefined),
          this.loginTimeoutMs,
        );
        timeoutHandle.unref?.();
        let active!: ActiveHandoff;
        const pollHandle = setInterval(() => this.pollCapture(active), 5);
        const constructed: ActiveHandoff = {
          workspaceId: id,
          directoryPath,
          requestPipePath,
          responsePipePath,
          requestFd,
          responseFd,
          targetUrl,
          clientModulePath: this.clientModulePath,
          expiresAt,
          timeoutHandle,
          pollHandle,
          chunks: [],
          byteLength: 0,
          pipesClosed: false,
          finished: false,
        };
        active = constructed;
        this.active = active;
        return this.status(id);
      } catch (error) {
        const active = this.active?.workspaceId === id ? this.active : undefined;
        if (active) await this.cleanupActive(active).catch(() => undefined);
        else {
          closeFileDescriptor(requestFd);
          closeFileDescriptor(responseFd);
          if (directoryPath) await removePrivateDirectory(directoryPath).catch(() => undefined);
        }
        this.sessionManager.cancelLogin(id);
        throw wrapBridgeError(error, "Unable to prepare the existing Chrome session handoff.");
      }
    });
  }

  complete(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    return this.exclusive(async () => {
      const id = requireWorkspaceId(workspaceId);
      const active = this.requireActive(id);
      if (active.failure) throw active.failure;
      if (!active.capture) {
        throw new ChromeLoginBridgeError("The existing Chrome TAPD tab has not handed off its session yet.");
      }
      const capture = active.capture;
      await this.cleanupActive(active, false);
      try {
        this.sessionManager.completeLogin(id, capture);
      } catch (error) {
        this.sessionManager.cancelLogin(id);
        throw error;
      } finally {
        capture.cookieJar.clear();
      }
      return this.status(id);
    });
  }

  cancel(workspaceId: string): Promise<ChromeLoginBridgeStatus> {
    return this.exclusive(async () => {
      const id = requireWorkspaceId(workspaceId);
      const active = this.active;
      if (active && active.workspaceId !== id) {
        throw new ChromeLoginBridgeStateError(
          `The pending existing-Chrome handoff belongs to workspace_id ${active.workspaceId}, not ${id}.`,
        );
      }
      if (active) await this.cleanupActive(active);
      this.sessionManager.cancelLogin(id);
      return this.status(id);
    });
  }

  getStatus(workspaceId: string): ChromeLoginBridgeStatus {
    return this.status(requireWorkspaceId(workspaceId));
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      const active = this.active;
      if (!active) return;
      await this.cleanupActive(active);
      this.sessionManager.cancelLogin(active.workspaceId);
    });
  }

  private pollCapture(active: ActiveHandoff): void {
    if (this.active !== active || active.finished || active.pipesClosed) return;
    const scratch = Buffer.allocUnsafe(64 * 1024);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let bytesRead: number;
        try {
          bytesRead = readSync(active.requestFd, scratch, 0, scratch.byteLength, null);
        } catch (error) {
          if (isWouldBlock(error)) return;
          throw error;
        }
        if (bytesRead <= 0) return;
        const bytes = Buffer.from(scratch.subarray(0, bytesRead));
        active.byteLength += bytes.byteLength;
        if (active.byteLength > MAX_EXISTING_CHROME_HANDOFF_BYTES) {
          bytes.fill(0);
          active.failure = new ChromeLoginBridgeError("The existing Chrome session capture is too large.");
          this.finishCapture(active, false);
          return;
        }
        active.chunks.push(bytes);
        if (!bytes.includes(0x0a)) continue;
        try {
          const combined = Buffer.concat(active.chunks);
          const newline = combined.indexOf(0x0a);
          const trailing = combined.subarray(newline + 1).toString("utf8").trim();
          if (newline < 0 || trailing) throw new Error("invalid frame");
          const envelope = JSON.parse(combined.subarray(0, newline).toString("utf8")) as unknown;
          combined.fill(0);
          active.capture = validateEnvelope(envelope, active.workspaceId, this.clock());
          this.finishCapture(active, true);
        } catch {
          active.failure = new ChromeLoginBridgeError("The existing Chrome session capture was rejected.");
          this.finishCapture(active, false);
        }
        return;
      }
    } catch {
      active.failure = new ChromeLoginBridgeError("The existing Chrome session handoff request failed.");
      this.finishCapture(active, false);
    } finally {
      scratch.fill(0);
    }
  }

  private finishCapture(active: ActiveHandoff, accepted: boolean): void {
    if (active.finished) return;
    active.finished = true;
    clearInterval(active.pollHandle);
    for (const chunk of active.chunks) chunk.fill(0);
    active.chunks.length = 0;
    const response = Buffer.from(JSON.stringify(accepted ? { ok: true } : { ok: false, error: "capture_rejected" }));
    try {
      writeSync(active.responseFd, response);
    } catch {
      active.failure ??= new ChromeLoginBridgeError("The existing Chrome session handoff response failed.");
    } finally {
      response.fill(0);
      this.closePipes(active);
    }
  }

  private status(workspaceId: string): ChromeLoginBridgeStatus {
    const active = this.active?.workspaceId === workspaceId ? this.active : undefined;
    return {
      workspaceId,
      state: this.sessionManager.getState(workspaceId),
      pageOpen: false,
      cleanupPending: Boolean(active),
      browserMode: "existing_chrome",
      captureReceived: Boolean(active?.capture),
      loginUrl: active?.targetUrl,
      handoff: active ? handoffDescriptor(active) : undefined,
    };
  }

  private requireActive(workspaceId: string): ActiveHandoff {
    if (!this.active || this.active.workspaceId !== workspaceId) {
      throw new ChromeLoginBridgeStateError(
        `No existing-Chrome session handoff is waiting for workspace_id ${workspaceId}.`,
      );
    }
    return this.active;
  }

  private async cleanupActive(active: ActiveHandoff, clearCapture = true): Promise<void> {
    clearTimeout(active.timeoutHandle);
    clearInterval(active.pollHandle);
    this.closePipes(active);
    for (const chunk of active.chunks) chunk.fill(0);
    active.chunks.length = 0;
    await removePrivateDirectory(active.directoryPath);
    if (clearCapture) active.capture?.cookieJar.clear();
    active.capture = undefined;
    if (this.active === active) this.active = undefined;
  }

  private closePipes(active: ActiveHandoff): void {
    if (active.pipesClosed) return;
    active.pipesClosed = true;
    closeFileDescriptor(active.requestFd);
    closeFileDescriptor(active.responseFd);
  }

  private async expireHandoff(workspaceId: string): Promise<void> {
    await this.exclusive(async () => {
      const active = this.active;
      if (!active || active.workspaceId !== workspaceId) return;
      try {
        await this.cleanupActive(active);
        this.sessionManager.cancelLogin(workspaceId);
      } catch {
        active.failure = new ChromeLoginBridgeError("The existing Chrome session handoff timed out and cleanup is pending.");
        this.sessionManager.markExpired(workspaceId, "The existing Chrome session handoff timed out.");
      }
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function handoffDescriptor(active: ActiveHandoff): ExistingChromeSessionHandoff {
  return {
    protocol: EXISTING_CHROME_SESSION_PROTOCOL,
    workspaceId: active.workspaceId,
    requestPipePath: active.requestPipePath,
    responsePipePath: active.responsePipePath,
    clientModulePath: active.clientModulePath,
    targetUrl: active.targetUrl,
    expiresAt: active.expiresAt,
  };
}

function validateEnvelope(
  value: unknown,
  expectedWorkspaceId: string,
  capturedAt: number,
): TapdWorkspaceSessionInput {
  if (!isRecord(value) || value.protocol !== EXISTING_CHROME_SESSION_PROTOCOL || !isRecord(value.capture)) {
    throw new ChromeLoginBridgeError("The existing Chrome session capture is invalid.");
  }
  const capture = value.capture;
  if (capture.workspaceId !== expectedWorkspaceId || capture.sourceOrigin !== TAPD_ORIGIN) {
    throw new ChromeLoginBridgeError("The existing Chrome session capture does not match the requested TAPD workspace.");
  }
  if (!Array.isArray(capture.cookies) || capture.cookies.length === 0 || capture.cookies.length > 128) {
    throw new ChromeLoginBridgeError("The existing Chrome session capture has no usable TAPD cookies.");
  }
  const cookies = capture.cookies.map(validateCookie);
  const cookieJar = SafeCookieJar.fromCookies(cookies, { allowedHostname: TAPD_HOSTNAME });
  if (!cookieJar.getCookieHeader(`${TAPD_ORIGIN}/`)) {
    throw new ChromeLoginBridgeError("The existing Chrome session capture has no usable TAPD cookies.");
  }
  const dscToken = requiredSecretText(capture.dscToken, "dsc_token", 16_384);
  return {
    workspaceId: expectedWorkspaceId,
    cookieJar,
    dscToken,
    storyContext: optionalEntityContext(capture.storyContext),
    bugContext: optionalEntityContext(capture.bugContext),
    capturedAt,
  };
}

function validateCookie(value: unknown): TapdCookieInput {
  if (!isRecord(value)) throw new ChromeLoginBridgeError("The existing Chrome session capture contains an invalid cookie.");
  const name = requiredCookiePart(value.name, "name", 256);
  const cookieValue = requiredCookiePart(value.value, "value", 16_384);
  const rawDomain = typeof value.domain === "string" ? value.domain.trim().toLowerCase() : "";
  const domain = rawDomain.replace(/^\.+/, "");
  if (!domain || (domain !== "tapd.cn" && !domain.endsWith(".tapd.cn"))) {
    throw new ChromeLoginBridgeError("The existing Chrome session capture contains a cookie outside tapd.cn.");
  }
  const path = typeof value.path === "string" && value.path.startsWith("/") ? value.path : "/";
  const expires = typeof value.expires === "number" && Number.isFinite(value.expires) ? value.expires : undefined;
  return {
    name,
    value: cookieValue,
    domain: rawDomain,
    path,
    expires,
    httpOnly: value.httpOnly === true,
    secure: value.secure === true,
    sameSite: typeof value.sameSite === "string" ? value.sameSite : undefined,
  };
}

function optionalEntityContext(value: unknown): TapdEntitySessionContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ChromeLoginBridgeError("The existing Chrome workspace context is invalid.");
  const confId = optionalNumericOrEmpty(value.confId, "conf_id");
  const queryToken = optionalSecretText(value.queryToken, "query_token", 32_768);
  const workitemTypeId = optionalNumeric(value.workitemTypeId, "workitem_type_id");
  return confId !== undefined || queryToken !== undefined || workitemTypeId !== undefined
    ? { confId, queryToken, workitemTypeId }
    : undefined;
}

function requiredCookiePart(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new ChromeLoginBridgeError(`The existing Chrome session capture contains an invalid cookie ${name}.`);
  }
  return value;
}

function requiredSecretText(value: unknown, name: string, maxLength: number): string {
  const text = optionalSecretText(value, name, maxLength);
  if (text === undefined || text.length === 0) {
    throw new ChromeLoginBridgeError(`The existing Chrome session capture is missing ${name}.`);
  }
  return text;
}

function optionalSecretText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
    throw new ChromeLoginBridgeError(`The existing Chrome workspace context contains an invalid ${name}.`);
  }
  return value.trim();
}

function optionalNumericOrEmpty(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return "";
  return optionalNumeric(value, name);
}

function optionalNumeric(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) {
    throw new ChromeLoginBridgeError(`The existing Chrome workspace context contains an invalid ${name}.`);
  }
  return value.trim();
}

function defaultLoginUrl(workspaceId: string): string {
  return `https://www.tapd.cn/tapd_fe/${encodeURIComponent(workspaceId)}/story/list?useScene=storyList`;
}

function validateTapdLoginUrl(rawUrl: string, workspaceId: string): string {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:"
    || url.hostname !== TAPD_HOSTNAME
    || !url.pathname.includes(`/${workspaceId}/`)
  ) {
    throw new ChromeLoginBridgeError(`The existing Chrome target must use ${TAPD_ORIGIN} and the requested workspace_id.`);
  }
  return url.toString();
}

function createNamedPipes(executablePath: string, requestPath: string, responsePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [requestPath, responsePath], { stdio: "ignore" });
    child.once("error", () => reject(new ChromeLoginBridgeError("Unable to create the private Chrome handoff pipes.")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new ChromeLoginBridgeError("Unable to create the private Chrome handoff pipes."));
    });
  });
}

function findMkfifoExecutable(): string {
  const candidates = ["/usr/bin/mkfifo", "/bin/mkfifo"];
  const match = candidates.find(existsSync);
  if (!match) throw new ChromeLoginBridgeError("The existing Chrome session bridge requires the system mkfifo utility.");
  return match;
}

function closeFileDescriptor(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Cleanup is idempotent; an already-closed FIFO descriptor is harmless.
  }
}

function isWouldBlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

async function removePrivateDirectory(directoryPath: string): Promise<void> {
  if (!basename(directoryPath).startsWith(EXISTING_CHROME_HANDOFF_PREFIX)) {
    throw new ChromeLoginBridgeError("Refusing to clean an unexpected Chrome handoff directory.");
  }
  await rm(directoryPath, { recursive: true, force: true });
}

function requireWorkspaceId(workspaceId: string | undefined): string {
  const id = workspaceId?.trim();
  if (!id || !/^[1-9]\d*$/.test(id)) {
    throw new ChromeLoginBridgeStateError("workspace_id is required and must be a positive numeric string.");
  }
  return id;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ChromeLoginBridgeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function wrapBridgeError(error: unknown, fallback: string): ChromeLoginBridgeError {
  return error instanceof ChromeLoginBridgeError ? error : new ChromeLoginBridgeError(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
