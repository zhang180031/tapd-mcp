const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(?:authorization|cookie|set[_-]?cookie|password|passwd|secret|credential|token|dsc[_-]?token|query[_-]?token|socket[_-]?token|csrf|xsrf|access[_-]?token|refresh[_-]?token|tapd[_-]?session|session(?:[_-]?id)?)(?:$|[_-])/i;
const RECOVERY_KEY_PATTERN =
  /(?:^|[_-])(?:recover(?:y)?|restore|undo|rollback|recycle[_-]?bin)(?:$|[_-])/i;

const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(token|dsc_token|query_token|socket_token|access_token|refresh_token|csrf_token|xsrf_token|tapd_session)=([^\s&#;,]+)/gi,
  /\b(cookie|set-cookie|authorization)\s*[:=]\s*[^\r\n]*/gi,
];

export interface RedactionOptions {
  /** Replacement used when a secret is embedded in an otherwise useful string. */
  replacement?: string;
}

/**
 * Produces a detached, JSON-safe value for logs and MCP responses.
 *
 * Secret-bearing properties and deletion-recovery properties are omitted at
 * every depth. Recognisable credentials embedded in strings are replaced.
 * The input is never mutated.
 */
export function redactSensitive(value: unknown, options: RedactionOptions = {}): unknown {
  const replacement = options.replacement ?? REDACTED;
  return redactValue(value, replacement, new WeakSet<object>());
}

/** Intent-revealing alias used at the MCP output boundary. */
export const sanitizeTapdOutput = redactSensitive;

export function isSensitiveKey(key: string): boolean {
  const normalised = key.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SECRET_KEY_PATTERN.test(normalised) || RECOVERY_KEY_PATTERN.test(normalised);
}

function redactValue(value: unknown, replacement: string, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, replacement);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message, replacement),
      };
    }
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, replacement, seen));
    }
    if (value instanceof Map) {
      const output: Record<string, unknown> = {};
      for (const [rawKey, entry] of value.entries()) {
        const key = String(rawKey);
        if (!isSensitiveKey(key)) output[key] = redactValue(entry, replacement, seen);
      }
      return output;
    }
    if (value instanceof Set) {
      return [...value].map((entry) => redactValue(entry, replacement, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!isSensitiveKey(key)) output[key] = redactValue(entry, replacement, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function redactString(value: string, replacement: string): string {
  let output = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match, prefix: string) => {
      if (/^(Basic|Bearer)$/i.test(prefix)) return `${prefix} ${replacement}`;
      if (/^(cookie|set-cookie|authorization)$/i.test(prefix)) return `${prefix}: ${replacement}`;
      return `${prefix}=${replacement}`;
    });
  }
  return output;
}
