import { chromium, type Browser } from "playwright";
import type { Rule, ExtractResult } from "../../../shared/types.js";
import { AppError } from "../errors.js";
import { extract } from "./extractor.js";
import { assertPublicUrl } from "./network.js";

export interface BrowserOptions {
  allowedHosts?: string[];
  navigationTimeoutMs?: number;
  targetTimeoutMs?: number;
  stabilityTimeoutMs?: number;
  sampleIntervalMs?: number;
  checkTimeoutMs?: number;
}

export class BrowserCollector {
  private launching?: Promise<Browser>;
  activeContexts = 0;
  constructor(private options: BrowserOptions = {}) {}

  async collect(
    rule: Rule,
    options: { thumbnail?: boolean } = {},
  ): Promise<ExtractResult & { thumbnail?: Uint8Array }> {
    await assertPublicUrl(rule.url, this.options.allowedHosts);
    this.launching ??= chromium
      .launch({ headless: true, chromiumSandbox: true })
      .then((browser) => {
        browser.on("disconnected", () => {
          this.launching = undefined;
        });
        return browser;
      })
      .catch((error) => {
        this.launching = undefined;
        throw error;
      });
    const browser = await this.launching;
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
    });
    this.activeContexts++;
    let blockedMain = false;
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        void context.close().catch(() => {});
      },
      this.options.checkTimeoutMs ??
        (this.options.navigationTimeoutMs ?? 20_000) +
          (this.options.targetTimeoutMs ?? 10_000) +
          (this.options.stabilityTimeoutMs ?? 10_000) +
          2000,
    );
    try {
      await context.route("**/*", async (route) => {
        try {
          await assertPublicUrl(
            route.request().url(),
            this.options.allowedHosts,
          );
          await route.continue();
        } catch {
          if (
            route.request().isNavigationRequest() &&
            !route.request().frame().parentFrame()
          )
            blockedMain = true;
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", (ws) => ws.close());
      const page = await context.newPage();
      page.on("popup", (popup) => {
        void popup.close();
      });
      let response;
      try {
        response = await page.goto(rule.url, {
          waitUntil: "domcontentloaded",
          timeout: this.options.navigationTimeoutMs ?? 20_000,
        });
      } catch {
        throw new AppError(
          blockedMain ? "PRIVATE_ADDRESS" : "NAVIGATION_FAILED",
          blockedMain
            ? "页面跳转到非公开地址，已阻止。"
            : "页面导航失败或超时。",
        );
      }
      if (!response || !response.ok())
        throw new AppError(
          `HTTP_${response?.status() ?? "ERROR"}`,
          `目标页面返回 HTTP ${response?.status() ?? "错误"}。`,
        );
      // Reject non-CSS Playwright selector engines before waiting.
      try {
        await page.evaluate((r) => {
          document.querySelector(r.selector);
          for (const s of r.ignoreSelectors ?? []) document.querySelector(s);
          if (r.titleSelector) document.querySelector(r.titleSelector);
          if (r.linkSelector) document.querySelector(r.linkSelector);
        }, rule);
      } catch {
        throw new AppError("INVALID_SELECTOR", "CSS 选择器语法无效。");
      }
      try {
        await page
          .locator(`css=${rule.selector}`)
          .first()
          .waitFor({
            state: "attached",
            timeout: this.options.targetTimeoutMs ?? 10_000,
          });
      } catch {
        throw new AppError(
          "TARGET_TIMEOUT",
          "等待目标元素超时，请检查选择器。",
        );
      }
      const deadline = Date.now() + (this.options.stabilityTimeoutMs ?? 10_000);
      let previous: string | undefined;
      let lastError: AppError | undefined;
      while (Date.now() < deadline) {
        try {
          const result = await extract(page, rule);
          const signature = JSON.stringify(result);
          if (signature === previous) {
            if (!options.thumbnail) return result;
            // A failed thumbnail must not discard a valid extraction or its baseline.
            let thumbnail: Uint8Array | undefined;
            try {
              thumbnail = await page.screenshot({
                type: "jpeg",
                quality: 55,
                timeout: 4000,
              });
            } catch {
              /* The current-content view can still display the extracted text. */
            }
            return { ...result, ...(thumbnail ? { thumbnail } : {}) };
          }
          previous = signature;
          lastError = undefined;
        } catch (error) {
          if (timedOut)
            throw new AppError(
              "CHECK_TIMEOUT",
              "本次采集超过总等待上限，已关闭浏览器上下文。",
            );
          previous = undefined;
          lastError =
            error instanceof AppError
              ? error
              : new AppError("EXTRACTION_FAILED", "提取失败。");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.sampleIntervalMs ?? 1000),
        );
      }
      if (lastError) throw lastError;
      throw new AppError(
        "UNSTABLE_CONTENT",
        "内容在等待时间内未稳定，请缩小监控范围或排除动态元素。",
      );
    } catch (error) {
      if (timedOut)
        throw new AppError(
          "CHECK_TIMEOUT",
          "本次采集超过总等待上限，已关闭浏览器上下文。",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      try {
        await context.close();
      } finally {
        this.activeContexts--;
      }
    }
  }

  async close() {
    const pending = this.launching;
    this.launching = undefined;
    if (pending) await (await pending).close();
  }
}
