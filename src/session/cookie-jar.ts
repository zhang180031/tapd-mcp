export interface TapdCookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Unix seconds (browser cookie format) or Unix milliseconds. Zero means a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
}

export interface TapdCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly expiresAt?: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: string;
}

export interface SafeCookieJarOptions {
  allowedHostname?: string;
  clock?: () => number;
}

interface StoredCookie extends TapdCookie {
  readonly sequence: number;
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A deliberately single-origin cookie jar. JSON serialisation never exposes
 * values, while the session store can explicitly persist a validated capture.
 */
export class SafeCookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly allowedHostname: string;
  private readonly clock: () => number;
  private sequence = 0;

  constructor(options: SafeCookieJarOptions = {}) {
    this.allowedHostname = normaliseHostname(options.allowedHostname ?? "www.tapd.cn");
    this.clock = options.clock ?? Date.now;
  }

  static fromCookies(
    cookies: readonly TapdCookieInput[],
    options: SafeCookieJarOptions = {},
  ): SafeCookieJar {
    const jar = new SafeCookieJar(options);
    jar.mergeCookies(cookies);
    return jar;
  }

  get size(): number {
    this.removeExpired();
    return this.cookies.size;
  }

  mergeSetCookie(
    headers: string | readonly string[],
    requestUrl = `https://${this.allowedHostname}/`,
  ): void {
    const url = this.assertAllowedUrl(requestUrl);
    const values = Array.isArray(headers) ? headers : [headers];
    for (const header of values) {
      for (const serialisedCookie of splitSetCookieHeader(header)) {
        const parsed = parseSetCookie(serialisedCookie, url, this.clock());
        if (parsed) this.mergeNormalisedCookie(parsed);
      }
    }
  }

  mergeCookies(cookies: readonly TapdCookieInput[]): void {
    for (const cookie of cookies) {
      const domainText = cookie.domain?.trim();
      const domain = normaliseHostname(domainText || this.allowedHostname);
      if (!domainMatches(this.allowedHostname, domain, false)) continue;
      if (!COOKIE_NAME_PATTERN.test(cookie.name) || containsUnsafeCookieValue(cookie.value)) continue;

      const expiresAt = normaliseExpiry(cookie.expires);
      const normalised: TapdCookie = {
        name: cookie.name,
        value: cookie.value,
        domain,
        hostOnly: !domainText,
        path: normalisePath(cookie.path),
        expiresAt,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? false,
        sameSite: cookie.sameSite,
      };
      this.mergeNormalisedCookie(normalised);
    }
  }

  getCookieHeader(requestUrl = `https://${this.allowedHostname}/`): string {
    const url = this.assertAllowedUrl(requestUrl);
    this.removeExpired();
    return [...this.cookies.values()]
      .filter((cookie) => cookieMatchesUrl(cookie, url))
      .sort((left, right) => right.path.length - left.path.length || left.sequence - right.sequence)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  clone(): SafeCookieJar {
    const copy = new SafeCookieJar({ allowedHostname: this.allowedHostname, clock: this.clock });
    copy.mergeCookies(
      [...this.cookies.values()].map((cookie) => ({
        ...cookie,
        expires: cookie.expiresAt,
      })),
    );
    return copy;
  }

  /**
   * Credential-bearing representation for the private session store only.
   * Do not return this value from an MCP tool, log it, or serialise the jar
   * through its public toJSON method.
   */
  exportCookies(): TapdCookieInput[] {
    this.removeExpired();
    return [...this.cookies.values()].map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.hostOnly ? undefined : cookie.domain,
      path: cookie.path,
      expires: cookie.expiresAt,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }

  clear(): void {
    this.cookies.clear();
  }

  /** Safe metadata only. Cookie values are intentionally unavailable here. */
  toJSON(): object {
    this.removeExpired();
    return {
      hostname: this.allowedHostname,
      size: this.cookies.size,
      cookieNames: [...new Set([...this.cookies.values()].map((cookie) => cookie.name))].sort(),
    };
  }

  private mergeNormalisedCookie(cookie: TapdCookie): void {
    if (!domainMatches(this.allowedHostname, cookie.domain, false)) return;
    const key = cookieKey(cookie);
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= this.clock()) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { ...cookie, sequence: this.sequence++ });
  }

  private removeExpired(): void {
    const now = this.clock();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.cookies.delete(key);
    }
  }

  private assertAllowedUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new TypeError("A valid absolute TAPD request URL is required.");
    }
    if (normaliseHostname(url.hostname) !== this.allowedHostname) {
      throw new TypeError(`Cookie access is restricted to ${this.allowedHostname}.`);
    }
    return url;
  }
}

function parseSetCookie(serialised: string, requestUrl: URL, now: number): TapdCookie | undefined {
  if (!serialised || /[\r\n]/.test(serialised)) return undefined;
  const parts = serialised.split(";").map((part) => part.trim());
  const pair = parts.shift();
  if (!pair) return undefined;
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!COOKIE_NAME_PATTERN.test(name) || containsUnsafeCookieValue(value)) return undefined;

  let domain = normaliseHostname(requestUrl.hostname);
  let hostOnly = true;
  let path = defaultCookiePath(requestUrl.pathname);
  let expiresAt: number | undefined;
  let httpOnly = false;
  let secure = false;
  let sameSite: string | undefined;

  for (const attribute of parts) {
    const attributeSeparator = attribute.indexOf("=");
    const rawName = attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator);
    const rawValue = attributeSeparator === -1 ? "" : attribute.slice(attributeSeparator + 1).trim();
    switch (rawName.trim().toLowerCase()) {
      case "domain":
        if (rawValue) {
          domain = normaliseHostname(rawValue);
          hostOnly = false;
        }
        break;
      case "path":
        path = normalisePath(rawValue);
        break;
      case "expires": {
        const parsed = Date.parse(rawValue);
        if (Number.isFinite(parsed)) expiresAt = parsed;
        break;
      }
      case "max-age": {
        const seconds = Number(rawValue);
        if (Number.isFinite(seconds)) expiresAt = seconds <= 0 ? now : now + seconds * 1_000;
        break;
      }
      case "httponly":
        httpOnly = true;
        break;
      case "secure":
        secure = true;
        break;
      case "samesite":
        sameSite = rawValue;
        break;
    }
  }

  if (!domainMatches(requestUrl.hostname, domain, hostOnly)) return undefined;
  return { name, value, domain, hostOnly, path, expiresAt, httpOnly, secure, sameSite };
}

function splitSetCookieHeader(header: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"' && header[index - 1] !== "\\") quoted = !quoted;
    if (character !== "," || quoted) continue;
    const remainder = header.slice(index + 1);
    if (/^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(remainder)) {
      result.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(header.slice(start).trim());
  return result.filter(Boolean);
}

function normaliseExpiry(expires: number | undefined): number | undefined {
  if (expires === undefined || expires === 0 || expires === -1 || !Number.isFinite(expires)) return undefined;
  return expires < 1_000_000_000_000 ? expires * 1_000 : expires;
}

function normaliseHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

function normalisePath(value: string | undefined): string {
  return value?.startsWith("/") ? value : "/";
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function containsUnsafeCookieValue(value: string): boolean {
  return /[\u0000-\u001F\u007F;,]/.test(value);
}

function domainMatches(hostname: string, domain: string, hostOnly: boolean): boolean {
  const host = normaliseHostname(hostname);
  const candidate = normaliseHostname(domain);
  return hostOnly ? host === candidate : host === candidate || host.endsWith(`.${candidate}`);
}

function cookieMatchesUrl(cookie: StoredCookie, url: URL): boolean {
  if (!domainMatches(url.hostname, cookie.domain, cookie.hostOnly)) return false;
  if (cookie.secure && url.protocol !== "https:") return false;
  const requestPath = url.pathname || "/";
  return requestPath === cookie.path || requestPath.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`);
}

function cookieKey(cookie: Pick<TapdCookie, "domain" | "path" | "name">): string {
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
}
