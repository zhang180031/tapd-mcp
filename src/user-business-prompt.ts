import { readFileSync } from "node:fs";

/**
 * User business guidance is deliberately optional: a missing, unreadable, or
 * blank file must never prevent TAPD's protocol tools from starting.
 *
 * The content remains user-authored data. It is read only while the MCP server
 * starts and is passed to the MCP client as business guidance; the service
 * never executes it or treats it as configuration code.
 */
export function loadUserBusinessPrompt(path: string | undefined): string | undefined {
  const normalizedPath = path?.trim();
  if (!normalizedPath) return undefined;

  try {
    const prompt = readFileSync(normalizedPath, "utf8").trim();
    return prompt || undefined;
  } catch {
    return undefined;
  }
}
