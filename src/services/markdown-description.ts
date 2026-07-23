import { InvalidArgumentError } from "../private-api/errors.js";
import { redactSensitive } from "../security/index.js";

export interface TapdMarkdownDescription {
  readonly markdown: string;
  readonly html: string;
}

export function toTapdMarkdownDescription(
  value: string,
  argument = "description",
  maxLength = 200_000,
): TapdMarkdownDescription {
  if (typeof value !== "string") {
    throw new InvalidArgumentError(argument, `${argument} must be Markdown text.`);
  }
  const source = value.replace(/\r\n?/g, "\n").trim();
  const redacted = redactSensitive(source);
  const markdown = typeof redacted === "string" ? redacted : source;
  if (!markdown) throw new InvalidArgumentError(argument, `${argument} must not be empty.`);
  if (markdown.length > maxLength) throw new InvalidArgumentError(argument, `${argument} is too long.`);
  return { markdown, html: renderMarkdownToSafeHtml(markdown) };
}

export function renderMarkdownToSafeHtml(markdown: string): string {
  const blocks: string[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let listType: "ol" | "ul" | undefined;
  let listItems: string[] = [];
  let codeLanguage = "";
  let codeLines: string[] | undefined;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!listType || !listItems.length) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listType}>`);
    listType = undefined;
    listItems = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      if (codeLines) {
        const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
        blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = undefined;
        codeLanguage = "";
      } else {
        codeLines = [];
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(unordered[1]);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${renderInlineMarkdown(quote[1])}</p></blockquote>`);
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
      continue;
    }

    if (listType) flushList();
    paragraph.push(line.trim());
  }

  if (codeLines) {
    const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
    blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  flushList();

  const body = blocks.length ? blocks.join("") : "<p></p>";
  return `<div data-inline-code-theme="red" data-code-block-theme="default">${body}</div>`;
}

function renderInlineMarkdown(value: string): string {
  const source = value.replaceAll("\u0000", "�");
  const tokens: string[] = [];
  const tokenized = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g, (match, imageAlt, imageUrl, linkText, linkUrl) => {
    const rawUrl = String(imageUrl ?? linkUrl ?? "");
    const safeUrl = safeMarkdownUrl(rawUrl);
    if (!safeUrl) return match;
    const html = imageUrl !== undefined
      ? `<img src="${escapeAttribute(safeUrl)}" alt="${escapeAttribute(String(imageAlt ?? ""))}">`
      : `<a href="${escapeAttribute(safeUrl)}">${escapeHtml(String(linkText ?? ""))}</a>`;
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  });

  let rendered = escapeHtml(tokenized)
    .replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  rendered = rendered.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? "");
  return rendered;
}

function safeMarkdownUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
