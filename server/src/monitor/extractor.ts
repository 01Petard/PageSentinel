import type { Page } from "playwright";
import type { Rule, ExtractResult } from "../../../shared/types.js";
import { AppError } from "../errors.js";
import { normalizeText, normalizeItem, sha256 } from "./comparator.js";

export async function extract(page: Page, rule: Rule): Promise<ExtractResult> {
  const raw = await page
    .evaluate((config) => {
      const nodes = Array.from(document.querySelectorAll(config.selector));
      // Walk the original DOM without detaching or modifying nodes: innerText on a detached
      // clone loses layout visibility, while removing nodes can trigger application observers.
      const reader = {
        visibleText(root: Element): string {
          for (
            let ancestor = root.parentElement;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            if (
              getComputedStyle(ancestor).display === "none" ||
              ancestor.hasAttribute("hidden")
            )
              return "";
          }
          const walker = {
            walk(node: Node): string {
              if (node.nodeType === Node.TEXT_NODE)
                return node.textContent || "";
              if (!(node instanceof Element)) return "";
              const style = getComputedStyle(node);
              if (
                node.matches("script,style,noscript,template,[hidden]") ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
              )
                return "";
              if (
                node !== root &&
                config.mode === "TEXT" &&
                config.ignoreSelectors?.some((s) => node.matches(s))
              )
                return "";
              if (node.tagName === "BR") return "\n";
              const content = Array.from(node.childNodes)
                .map((child) => walker.walk(child))
                .join("");
              return [
                "block",
                "flex",
                "grid",
                "list-item",
                "table-row",
              ].includes(style.display)
                ? `\n${content}\n`
                : content;
            },
          };
          return walker.walk(root);
        },
      };
      if (config.mode === "TEXT")
        return {
          count: nodes.length,
          text: nodes.length === 1 ? reader.visibleText(nodes[0]) : "",
          items: [],
        };
      return {
        count: nodes.length,
        text: "",
        items:
          nodes.length > 200
            ? []
            : nodes.map((node) => {
                const links = config.linkSelector
                  ? Array.from(node.querySelectorAll(config.linkSelector))
                  : node.matches("a")
                    ? [node]
                    : Array.from(node.querySelectorAll("a[href]"));
                const titles = config.titleSelector
                  ? Array.from(node.querySelectorAll(config.titleSelector))
                  : [node];
                return {
                  href:
                    links.length === 1 ? links[0].getAttribute("href") : null,
                  baseUrl:
                    links.length === 1 ? links[0].baseURI : document.baseURI,
                  title:
                    titles.length === 1 ? reader.visibleText(titles[0]) : "",
                  linkCount: links.length,
                  titleCount: titles.length,
                };
              }),
      };
    }, rule)
    .catch(() => {
      throw new AppError(
        "EXTRACTION_FAILED",
        "提取失败，请检查 CSS 选择器或页面是否发生跳转。",
      );
    });
  if (rule.mode === "TEXT") {
    if (raw.count !== 1)
      throw new AppError(
        "MATCH_COUNT",
        `TEXT 选择器匹配 ${raw.count} 个区域，必须恰好匹配 1 个。`,
      );
    const text = normalizeText(raw.text);
    if (!text) throw new AppError("EMPTY_TEXT", "选中区域没有可见文本。");
    if (Buffer.byteLength(text, "utf8") > 256 * 1024)
      throw new AppError("TEXT_LIMIT", "文本超过 256 KiB，请缩小监控区域。");
    return { mode: "TEXT", text, hash: sha256(text), matchCount: raw.count };
  }
  if (!raw.count)
    throw new AppError("EMPTY_LIST", "列表为空，保留上次成功基线。");
  if (raw.count > 200)
    throw new AppError("LIST_LIMIT", "列表超过 200 条，请缩小监控范围。");
  const keys = new Set<string>();
  const items = raw.items.map((item) => {
    if (item.linkCount !== 1 || !item.href?.trim())
      throw new AppError(
        "MISSING_LINK",
        "每个列表项必须匹配一个非空详情链接。",
      );
    if (item.titleCount !== 1 || !normalizeText(item.title))
      throw new AppError("MISSING_TITLE", "每个列表项必须匹配一个非空标题。");
    const normalized = normalizeItem(item.title, item.href, item.baseUrl);
    if (keys.has(normalized.key))
      throw new AppError("DUPLICATE_KEY", "列表存在重复详情链接，请修正规则。");
    keys.add(normalized.key);
    return normalized;
  });
  return {
    mode: "LIST",
    items,
    hash: sha256(JSON.stringify(items)),
    matchCount: raw.count,
  };
}
