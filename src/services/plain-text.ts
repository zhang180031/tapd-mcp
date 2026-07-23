import { InvalidArgumentError } from "../private-api/errors.js";

export function plainTextToHtml(value: string, argument: string, maxLength: number): string {
  if (typeof value !== "string") throw new InvalidArgumentError(argument, `${argument} must be plain text.`);
  if (value.length > maxLength) throw new InvalidArgumentError(argument, `${argument} is too long.`);
  return `<p>${value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replace(/\r?\n/g, "<br>")}</p>`;
}
