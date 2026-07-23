import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SafeCookieJar, type TapdCookieInput } from "./cookie-jar.js";
import type { TapdEntitySessionContext, TapdWorkspaceSessionContext, TapdWorkspaceSessionInput } from "./types.js";

const VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COOKIE_COUNT = 128;

interface StoredSession {
  readonly cookies: TapdCookieInput[];
  readonly dscToken: string;
  readonly storyContext?: TapdEntitySessionContext;
  readonly bugContext?: TapdEntitySessionContext;
  readonly capturedAt: number;
  readonly expiresAt?: number;
}

interface StoredSessionFile {
  readonly version: typeof VERSION;
  readonly workspaces: Record<string, StoredSession>;
}

/**
 * Cross-platform, user-authorized persistent TAPD session storage. The file is
 * deliberately never surfaced through MCP results or diagnostics.
 */
export class JsonSessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly filePath: string | undefined) {}

  load(): TapdWorkspaceSessionInput[] {
    if (!this.filePath) return [];
    this.sessions.clear();
    let bytes: Buffer | undefined;
    try {
      bytes = readFileSync(this.filePath);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) return [];
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== VERSION || !isRecord(parsed.workspaces)) return [];
      for (const [workspaceId, rawSession] of Object.entries(parsed.workspaces)) {
        const session = parseStoredSession(workspaceId, rawSession);
        if (session) this.sessions.set(workspaceId, session);
      }
    } catch {
      // A missing, malformed, or unreadable local cache is treated as absent.
      return [];
    } finally {
      bytes?.fill(0);
    }
    return [...this.sessions.entries()].map(([workspaceId, session]) => toSessionInput(workspaceId, session));
  }

  save(context: Readonly<TapdWorkspaceSessionContext>): void {
    if (!this.filePath) return;
    const cookies = context.cookieJar.exportCookies();
    if (!cookies.length || !validSecret(context.dscToken, 16_384)) {
      this.remove(context.workspaceId);
      return;
    }
    this.sessions.set(context.workspaceId, {
      cookies,
      dscToken: context.dscToken,
      storyContext: cloneContext(context.storyContext),
      bugContext: cloneContext(context.bugContext),
      capturedAt: context.capturedAt,
      expiresAt: context.expiresAt,
    });
    this.write();
  }

  remove(workspaceId: string): void {
    if (!this.filePath) return;
    this.sessions.delete(workspaceId);
    this.write();
  }

  private write(): void {
    if (!this.filePath) return;
    const path = resolve(this.filePath);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Windows does not support POSIX mode bits. */ }

    const workspaces = Object.fromEntries(this.sessions.entries());
    const payload: StoredSessionFile = { version: VERSION, workspaces };
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let replaced = false;
    try {
      writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      try { chmodSync(temporaryPath, 0o600); } catch { /* Windows does not support POSIX mode bits. */ }
      renameSync(temporaryPath, path);
      replaced = true;
      try { chmodSync(path, 0o600); } catch { /* Windows does not support POSIX mode bits. */ }
    } finally {
      if (!replaced) {
        try { rmSync(temporaryPath, { force: true }); } catch { /* Best-effort cleanup. */ }
      }
    }
  }
}

function parseStoredSession(workspaceId: string, value: unknown): StoredSession | undefined {
  if (!/^[1-9]\d*$/.test(workspaceId) || !isRecord(value)) return undefined;
  if (!Array.isArray(value.cookies) || value.cookies.length === 0 || value.cookies.length > MAX_COOKIE_COUNT) return undefined;
  const cookies = value.cookies.map(parseCookie).filter((cookie): cookie is TapdCookieInput => Boolean(cookie));
  if (cookies.length !== value.cookies.length || !validSecret(value.dscToken, 16_384)) return undefined;
  const jar = SafeCookieJar.fromCookies(cookies);
  if (!jar.getCookieHeader()) return undefined;
  const capturedAt = validTimestamp(value.capturedAt) ? value.capturedAt : Date.now();
  const expiresAt = validTimestamp(value.expiresAt) ? value.expiresAt : undefined;
  return {
    cookies,
    dscToken: value.dscToken.trim(),
    storyContext: parseContext(value.storyContext),
    bugContext: parseContext(value.bugContext),
    capturedAt,
    expiresAt,
  };
}

function toSessionInput(workspaceId: string, session: StoredSession): TapdWorkspaceSessionInput {
  return {
    workspaceId,
    cookieJar: SafeCookieJar.fromCookies(session.cookies),
    dscToken: session.dscToken,
    // Sessions captured before the default-list fix may not contain a
    // workspace list context. TAPD accepts an empty conf_id for its default
    // Story/Bug lists, so migrate those caches without asking Chrome again.
    storyContext: cloneContext(session.storyContext) ?? { confId: "" },
    bugContext: cloneContext(session.bugContext) ?? { confId: "" },
    capturedAt: session.capturedAt,
    expiresAt: session.expiresAt,
  };
}

function parseCookie(value: unknown): TapdCookieInput | undefined {
  if (!isRecord(value) || !validCookiePart(value.name, 256) || !validCookiePart(value.value, 16_384)) return undefined;
  if (value.domain !== undefined && !validDomain(value.domain)) return undefined;
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.startsWith("/"))) return undefined;
  if (value.expires !== undefined && !validTimestamp(value.expires)) return undefined;
  return {
    name: value.name,
    value: value.value,
    domain: typeof value.domain === "string" ? value.domain : undefined,
    path: typeof value.path === "string" ? value.path : undefined,
    expires: typeof value.expires === "number" ? value.expires : undefined,
    httpOnly: value.httpOnly === true,
    secure: value.secure === true,
    sameSite: typeof value.sameSite === "string" ? value.sameSite : undefined,
  };
}

function parseContext(value: unknown): TapdEntitySessionContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const confId = validNumeric(value.confId) ? value.confId.trim() : undefined;
  const queryToken = validSecret(value.queryToken, 32_768) ? value.queryToken.trim() : undefined;
  const workitemTypeId = validNumeric(value.workitemTypeId) ? value.workitemTypeId.trim() : undefined;
  return confId || queryToken || workitemTypeId ? { confId, queryToken, workitemTypeId } : undefined;
}

function cloneContext(context: TapdEntitySessionContext | undefined): TapdEntitySessionContext | undefined {
  return context && { ...context };
}

function validCookiePart(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000\r\n]/.test(value);
}

function validSecret(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\u0000\r\n]/.test(value);
}

function validDomain(value: unknown): value is string {
  const domain = typeof value === "string" ? value.trim().replace(/^\.+/, "") : "";
  return domain === "tapd.cn" || domain.endsWith(".tapd.cn");
}

function validNumeric(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value.trim());
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
