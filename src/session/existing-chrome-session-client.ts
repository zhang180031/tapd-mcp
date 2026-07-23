import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

import {
  EXISTING_CHROME_HANDOFF_PREFIX,
  EXISTING_CHROME_REQUEST_PIPE_NAME,
  EXISTING_CHROME_RESPONSE_PIPE_NAME,
  EXISTING_CHROME_SESSION_PROTOCOL,
  MAX_EXISTING_CHROME_HANDOFF_BYTES,
  type ExistingChromeSessionCapture,
  type ExistingChromeSessionEnvelope,
  type ExistingChromeSessionHandoff,
} from "./existing-chrome-session-protocol.js";

export interface DeliverExistingChromeSessionOptions {
  timeoutMs?: number;
}

export interface ExistingChromeSessionDeliveryResult {
  readonly accepted: true;
  readonly workspaceId: string;
}

/**
 * Sends a TAPD-only capture directly from the Chrome control process to the
 * MCP through private POSIX named pipes. Callers must never print `capture`.
 */
export function deliverExistingChromeSession(
  handoff: ExistingChromeSessionHandoff,
  capture: ExistingChromeSessionCapture,
  options: DeliverExistingChromeSessionOptions = {},
): Promise<ExistingChromeSessionDeliveryResult> {
  validateHandoff(handoff);
  validateCaptureShape(capture, handoff.workspaceId);
  const timeoutMs = positiveDuration(options.timeoutMs, 10_000);
  const envelope: ExistingChromeSessionEnvelope = {
    protocol: EXISTING_CHROME_SESSION_PROTOCOL,
    capture,
  };
  const payload = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (payload.byteLength > MAX_EXISTING_CHROME_HANDOFF_BYTES) {
    payload.fill(0);
    throw new Error("The TAPD Chrome session handoff is too large.");
  }

  return new Promise((resolve, reject) => {
    const response = createReadStream(handoff.responsePipePath);
    let request: WriteStream | undefined;
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The TAPD Chrome session handoff timed out.")), timeoutMs);
    timer.unref?.();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      payload.fill(0);
      for (const chunk of responseChunks) chunk.fill(0);
      destroyStream(request);
      destroyStream(response);
      if (error) reject(error);
      else resolve({ accepted: true, workspaceId: handoff.workspaceId });
    };

    response.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      responseBytes += bytes.byteLength;
      if (responseBytes > 4_096) {
        bytes.fill(0);
        finish(new Error("The TAPD Chrome session bridge returned an invalid response."));
        return;
      }
      responseChunks.push(bytes);
    });
    response.once("error", () => finish(new Error("Unable to connect the existing Chrome session to TAPD MCP.")));
    response.once("end", () => {
      if (settled) return;
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
      } catch {
        finish(new Error("The TAPD Chrome session bridge returned an invalid response."));
        return;
      }
      if (!isRecord(result) || result.ok !== true) {
        finish(new Error("The TAPD Chrome session bridge rejected the capture."));
        return;
      }
      finish();
    });
    response.once("open", () => {
      if (settled) return;
      request = createWriteStream(handoff.requestPipePath);
      request.once("open", () => request?.end(payload));
      request.once("error", () => finish(new Error("Unable to connect the existing Chrome session to TAPD MCP.")));
    });
  });
}

function validateHandoff(handoff: ExistingChromeSessionHandoff): void {
  const requestDirectory = dirname(handoff.requestPipePath);
  const responseDirectory = dirname(handoff.responsePipePath);
  if (
    handoff.protocol !== EXISTING_CHROME_SESSION_PROTOCOL
    || !/^[1-9]\d*$/.test(handoff.workspaceId)
    || !isAbsolute(handoff.requestPipePath)
    || !isAbsolute(handoff.responsePipePath)
    || requestDirectory !== responseDirectory
    || basename(handoff.requestPipePath) !== EXISTING_CHROME_REQUEST_PIPE_NAME
    || basename(handoff.responsePipePath) !== EXISTING_CHROME_RESPONSE_PIPE_NAME
    || !basename(requestDirectory).startsWith(EXISTING_CHROME_HANDOFF_PREFIX)
  ) {
    throw new Error("The TAPD Chrome session handoff descriptor is invalid.");
  }
  const target = new URL(handoff.targetUrl);
  if (
    target.protocol !== "https:"
    || target.hostname !== "www.tapd.cn"
    || !target.pathname.includes(`/${handoff.workspaceId}/`)
  ) {
    throw new Error("The TAPD Chrome session handoff target is invalid.");
  }
}

function validateCaptureShape(capture: ExistingChromeSessionCapture, workspaceId: string): void {
  if (
    capture.workspaceId !== workspaceId
    || capture.sourceOrigin !== "https://www.tapd.cn"
    || !Array.isArray(capture.cookies)
    || capture.cookies.length === 0
    || capture.cookies.length > 128
    || typeof capture.dscToken !== "string"
    || capture.dscToken.length === 0
    || capture.dscToken.length > 16_384
  ) {
    throw new Error("The TAPD Chrome session capture is invalid.");
  }
  for (const cookie of capture.cookies) {
    const domain = cookie.domain?.trim().toLowerCase().replace(/^\.+/, "");
    if (!domain || (domain !== "tapd.cn" && !domain.endsWith(".tapd.cn"))) {
      throw new Error("The TAPD Chrome session capture contains a cookie outside tapd.cn.");
    }
  }
}

function destroyStream(stream: ReadStream | WriteStream | undefined): void {
  stream?.destroy();
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError("timeoutMs must be a positive integer.");
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
