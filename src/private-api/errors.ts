import { isSensitiveKey, redactSensitive } from "../security/redaction.js";

export type TapdPrivateErrorCode =
  | "SESSION_EXPIRED"
  | "WRITE_OUTCOME_UNKNOWN"
  | "CONTRACT_CHANGED"
  | "TAPD_REQUEST_FAILED"
  | "INVALID_ARGUMENT"
  | "WORKSPACE_CONTEXT_REQUIRED"
  | "AMBIGUOUS_NEXT_STEP";

export class TapdPrivateError extends Error {
  override readonly name: string = "TapdPrivateError";

  constructor(
    readonly code: TapdPrivateErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | undefined>> = {},
  ) {
    super(sanitizeDiagnosticText(message));
  }
}

export class SessionExpiredError extends TapdPrivateError {
  override readonly name: string = "SessionExpiredError";

  constructor(workspaceId: string, reason = "The TAPD login session is missing or expired.") {
    super("SESSION_EXPIRED", reason, { workspaceId });
  }
}

export class WriteOutcomeUnknownError extends TapdPrivateError {
  override readonly name: string = "WriteOutcomeUnknownError";

  constructor(
    endpoint: string,
    reason: "timeout" | "network" | "server_error" | "invalid_response",
    httpStatus?: number,
    responseShape?: string,
  ) {
    super(
      "WRITE_OUTCOME_UNKNOWN",
      "TAPD may have applied the write, but its result could not be confirmed. Query the work item before deciding whether to retry.",
      { endpoint, reason, httpStatus, ...(responseShape ? { responseShape } : {}) },
    );
  }
}

export class ContractChangedError extends TapdPrivateError {
  override readonly name: string = "ContractChangedError";

  constructor(endpoint: string, expected: string, responseShape?: string) {
    super("CONTRACT_CHANGED", "The TAPD private endpoint returned an unrecognised response shape.", {
      endpoint,
      expected,
      ...(responseShape ? { responseShape } : {}),
    });
  }
}

export class TapdRequestError extends TapdPrivateError {
  override readonly name: string = "TapdRequestError";

  constructor(endpoint: string, message = "TAPD rejected the request.", httpStatus?: number, requestId?: string) {
    super("TAPD_REQUEST_FAILED", message, { endpoint, httpStatus, requestId });
  }
}

export class InvalidArgumentError extends TapdPrivateError {
  override readonly name: string = "InvalidArgumentError";

  constructor(argument: string, message: string) {
    super("INVALID_ARGUMENT", message, { argument });
  }
}

export function sanitizeDiagnosticText(value: string): string {
  const centrallyRedacted = redactSensitive(value);
  return (typeof centrallyRedacted === "string" ? centrallyRedacted : "TAPD request failed.")
    .replace(/([?&](?:dsc_token|query_token|token|recovery_[^=]*)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(dsc_token|query_token|access_token|refresh_token)\b(?:\s*[:=]\s*|\s+)[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(cookie|authorization|dsc_token|query_token|password|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

const RESPONSE_SHAPE_MAX_DEPTH = 4;
const RESPONSE_SHAPE_MAX_WIDTH = 6;
const RESPONSE_SHAPE_MAX_LENGTH = 320;
const RESPONSE_SHAPE_MAX_KEY_LENGTH = 32;
const STATIC_RESPONSE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/;
const DATA_BEARING_RESPONSE_KEY_PATTERN =
  /(?:^|_)(?:id|ids|uuid|guid|url|uri|href|link|title|name|description|content|text|html|markdown)(?:$|_)/i;
const BROAD_SECRET_RESPONSE_KEY_PATTERN =
  /authorization|cookie|password|passwd|secret|credential|token|csrf|xsrf|session|recover|restore|undo|rollback|recycle/i;

/**
 * Returns a bounded, value-free description of a JSON response shape.
 *
 * This is intentionally lossy: only conservative, static-looking field names
 * and JSON type labels survive. It is safe to attach to diagnostics, but is not
 * a serialisation or hash of the response payload.
 */
export function responseShapeFingerprint(value: unknown): string {
  const fingerprint = describeResponseShape(value, 0, new WeakSet<object>());
  if (fingerprint.length <= RESPONSE_SHAPE_MAX_LENGTH) return fingerprint;
  return `${fingerprint.slice(0, RESPONSE_SHAPE_MAX_LENGTH - 3)}...`;
}

function describeResponseShape(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth >= RESPONSE_SHAPE_MAX_DEPTH || value.length === 0) return "array";
    return `array<${describeResponseShape(value[0], depth + 1, seen)}>`;
  }

  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": {
      if (depth >= RESPONSE_SHAPE_MAX_DEPTH || seen.has(value)) return "object";
      seen.add(value);
      try {
        const safeEntries = Object.entries(value)
          .filter(([key]) => isStaticResponseKey(key))
          .sort(([left], [right]) => left.localeCompare(right));
        const visibleEntries = safeEntries.slice(0, RESPONSE_SHAPE_MAX_WIDTH);
        if (visibleEntries.length === 0) return "object";
        const fields = visibleEntries.map(([key, entry]) =>
          `${key}:${describeResponseShape(entry, depth + 1, seen)}`,
        );
        if (safeEntries.length > visibleEntries.length) fields.push("...");
        return `object{${fields.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default: return "unknown";
  }
}

function isStaticResponseKey(key: string): boolean {
  if (!key || key.length > RESPONSE_SHAPE_MAX_KEY_LENGTH) return false;
  if (!STATIC_RESPONSE_KEY_PATTERN.test(key) || /\d{4,}/.test(key)) return false;
  if (isSensitiveKey(key) || BROAD_SECRET_RESPONSE_KEY_PATTERN.test(key)) return false;
  return !DATA_BEARING_RESPONSE_KEY_PATTERN.test(key);
}

export interface SafeFailure {
  code: TapdPrivateErrorCode | "INTERNAL_ERROR";
  message: string;
}

export function toSafeFailure(error: unknown): SafeFailure {
  if (error instanceof TapdPrivateError) return { code: error.code, message: error.message };
  return { code: "INTERNAL_ERROR", message: "The TAPD operation failed unexpectedly." };
}
