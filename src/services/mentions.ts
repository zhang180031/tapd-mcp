import { InvalidArgumentError } from "../private-api/errors.js";
import { plainTextToHtml } from "./plain-text.js";

export interface TapdMention {
  /** TAPD's workspace-scoped member nickname, returned by tapd_search_members. */
  nick: string;
  /** TAPD's display name, returned alongside nick by tapd_search_members. */
  name: string;
}

const mentionStyle = "font-weight: normal;background-color: #ffefd3;color: #3582fb;padding: 1px 4px;border-radius: 3px;cursor: pointer;";

/**
 * Serializes only explicitly selected TAPD members into the `at-who` element
 * used by the browser editor. Ordinary text remains escaped exactly as it was
 * before mention support was added.
 */
export function commentToHtml(comment: string, mentions: readonly TapdMention[] | undefined): string {
  if (!mentions?.length) return plainTextToHtml(comment, "comment", 10_000);
  if (typeof comment !== "string") throw new InvalidArgumentError("comment", "comment must be plain text.");
  if (comment.length > 10_000) throw new InvalidArgumentError("comment", "comment is too long.");

  const normalized = normalizeMentions(mentions);
  const replacements = normalized.map((mention) => ({
    marker: `@${mention.nick}(${mention.name})`,
    html: mentionToHtml(mention),
  }));
  for (const replacement of replacements) {
    if (!comment.includes(replacement.marker)) {
      throw new InvalidArgumentError(
        "mentions",
        `The comment must include the exact selected member marker ${replacement.marker}.`,
      );
    }
  }

  const matcher = new RegExp(replacements.map((replacement) => escapeRegExp(replacement.marker)).join("|"), "g");
  let index = 0;
  let html = "";
  for (const match of comment.matchAll(matcher)) {
    const marker = match[0];
    const start = match.index ?? index;
    html += escapeHtml(comment.slice(index, start));
    html += replacements.find((replacement) => replacement.marker === marker)?.html ?? escapeHtml(marker);
    index = start + marker.length;
  }
  html += escapeHtml(comment.slice(index));
  return `<p>${html.replace(/\r?\n/g, "<br>")}</p>`;
}

function normalizeMentions(mentions: readonly TapdMention[]): TapdMention[] {
  if (mentions.length > 20) throw new InvalidArgumentError("mentions", "At most 20 TAPD members can be mentioned in one comment.");
  const byNick = new Map<string, TapdMention>();
  for (const mention of mentions) {
    if (!mention || typeof mention.nick !== "string" || typeof mention.name !== "string") {
      throw new InvalidArgumentError("mentions", "Each mention must contain the TAPD member nick and name returned by tapd_search_members.");
    }
    const nick = mention.nick.trim();
    const name = mention.name.trim();
    if (!nick || !name || nick.length > 128 || name.length > 128 || /[\r\n]/.test(nick) || /[\r\n]/.test(name)) {
      throw new InvalidArgumentError("mentions", "Each mention nick and name must be a non-empty single-line value of at most 128 characters.");
    }
    const existing = byNick.get(nick);
    if (existing && existing.name !== name) {
      throw new InvalidArgumentError("mentions", `TAPD member nick ${nick} was supplied with conflicting names.`);
    }
    byNick.set(nick, { nick, name });
  }
  return [...byNick.values()].sort((left, right) => right.nick.length - left.nick.length);
}

function mentionToHtml(mention: TapdMention): string {
  const label = `@${mention.nick}(${mention.name})`;
  return `<b class="at-who" contenteditable="false" style="${mentionStyle}" data-userid="${escapeHtml(mention.nick)}" data-type="user">${escapeHtml(label)}</b>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
