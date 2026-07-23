import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { InvalidArgumentError } from "../private-api/errors.js";
import { PrivateHttpClient } from "../private-api/private-http-client.js";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function descriptionWithImages(input: {
  client: PrivateHttpClient;
  workspaceId: string;
  markdown?: string;
  existingMarkdown?: string;
  imagePaths: readonly string[];
}): Promise<string> {
  if (input.imagePaths.length > MAX_IMAGES) throw new InvalidArgumentError("image_paths", `At most ${MAX_IMAGES} images are allowed.`);
  const base = input.markdown === undefined ? input.existingMarkdown ?? "" : input.markdown;
  const uploaded: string[] = [];
  for (const path of input.imagePaths) {
    if (!isAbsolute(path)) throw new InvalidArgumentError("image_paths", "Every image path must be absolute.");
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch {
      throw new InvalidArgumentError("image_paths", `Image cannot be read: ${path}`);
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new InvalidArgumentError("image_paths", `Each image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType) throw new InvalidArgumentError("image_paths", `Unsupported image content: ${path}`);
    uploaded.push((await input.client.uploadEditorImage({ workspaceId: input.workspaceId, bytes, mimeType })).value);
  }
  const imageMarkdown = uploaded.map((src, index) => `![附件证据 ${index + 1}](${src})`);
  return [base.trim(), ...imageMarkdown].filter(Boolean).join("\n\n");
}

function detectImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return "image/jpeg";
  const head = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
