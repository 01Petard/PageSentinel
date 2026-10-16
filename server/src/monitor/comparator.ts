import { createHash } from "node:crypto";
import { diffLines } from "diff";
import type { ListItem } from "../../../shared/types.js";
import { AppError } from "../errors.js";

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function normalizeItem(
  title: string,
  href: string,
  baseUrl: string,
): ListItem {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new AppError("INVALID_LINK", "详情链接无法解析，请修正链接规则。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new AppError(
      "INVALID_LINK",
      "详情链接必须为不含凭据的 HTTP(S) URL。",
    );
  url.hash = "";
  return { key: sha256(url.href), title: normalizeText(title), url: url.href };
}

export function compareText(before: string, after: string) {
  const oldText = normalizeText(before),
    newText = normalizeText(after);
  return {
    changed: sha256(oldText) !== sha256(newText),
    diff: diffLines(oldText + "\n", newText + "\n"),
  };
}

export function unseenItems(items: ListItem[], seen: Set<string>): ListItem[] {
  return items.filter((item) => !seen.has(item.key));
}
