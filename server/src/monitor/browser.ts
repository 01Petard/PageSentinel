import { chromium, type Browser, type Page } from "playwright";
import type {
  Rule,
  ExtractResult,
  AuthProfileInput,
} from "../../../shared/types.js";
import { AppError } from "../errors.js";
import { extract } from "./extractor.js";
import { assertPublicUrl } from "./network.js";
import { assertApprovedUrl, approvedState } from "../auth/state-parser.js";
import type { StorageState } from "../auth/types.js";

export interface BrowserOptions {
  allowedHosts?: string[];
  navigationTimeoutMs?: number;
  targetTimeoutMs?: number;
  stabilityTimeoutMs?: number;
  sampleIntervalMs?: number;
  checkTimeoutMs?: number;
}
export interface BrowserAuthentication {
  profile: AuthProfileInput;
  state: StorageState;
  successSelector?: string;
  onState?: (state: StorageState) => void;
}
export class BrowserCollector {
  private launching?: Promise<Browser>;
  activeContexts = 0;
  constructor(private options: BrowserOptions = {}) {}
  validateUrl(url: string) {
    return assertPublicUrl(url, this.options.allowedHosts);
  }

  async verifyAuthentication(profile: AuthProfileInput, state: StorageState) {
    let rotated!: StorageState;
    const finalUrl = await this.withPage(
      profile.verificationUrl,
      {
        profile,
        state,
        onState: (value) => {
          rotated = value;
        },
      },
      async (page) => page.url(),
    );
    return { finalUrl, state: rotated };
  }
  async collect(
    rule: Rule,
    options: {
      thumbnail?: boolean;
      authentication?: BrowserAuthentication;
    } = {},
  ): Promise<ExtractResult & { thumbnail?: Uint8Array }> {
    return this.withPage(rule.url, options.authentication, async (page) => {
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
      let previous: string | undefined, lastError: AppError | undefined;
      while (Date.now() < deadline) {
        try {
          const result = await extract(page, rule),
            signature = JSON.stringify(result);
          if (signature === previous) {
            if (!options.thumbnail) return result;
            let thumbnail: Uint8Array | undefined;
            try {
              thumbnail = await page.screenshot({
                type: "jpeg",
                quality: 55,
                timeout: 4000,
              });
            } catch {
              /* Valid content remains usable without an image. */
            }
            return { ...result, ...(thumbnail ? { thumbnail } : {}) };
          }
          previous = signature;
          lastError = undefined;
        } catch (error) {
          if (page.isClosed()) throw error;
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
    });
  }
  private async withPage<T>(
    url: string,
    authentication: BrowserAuthentication | undefined,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    await this.validateUrl(url);
    if (authentication) assertApprovedUrl(url, authentication.profile);
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
    const context = await (
      await this.launching
    ).newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
      ...(authentication ? { storageState: authentication.state } : {}),
    });
    this.activeContexts++;
    let blockedMain = false,
      blockedDomain = false,
      timedOut = false,
      authenticated = false;
    let activePage: Page | undefined;
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
        let main = route.request().isNavigationRequest();
        if (main) {
          try {
            main = !route.request().frame().parentFrame();
          } catch {
            /* The first popup request may arrive before its frame. */
          }
        }
        try {
          await this.validateUrl(route.request().url());
          if (main && authentication) {
            try {
              assertApprovedUrl(route.request().url(), authentication.profile);
            } catch (error) {
              blockedDomain = true;
              throw error;
            }
          }
          await route.continue();
        } catch {
          if (main) blockedMain = true;
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (ws) => ws.close());
      const page = await context.newPage();
      activePage = page;
      page.on("popup", (popup) => {
        void popup.close();
      });
      let response;
      try {
        response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.options.navigationTimeoutMs ?? 20_000,
        });
      } catch {
        throw new AppError(
          blockedDomain
            ? "AUTH_DOMAIN"
            : blockedMain
              ? "PRIVATE_ADDRESS"
              : "NAVIGATION_FAILED",
          blockedDomain
            ? "页面跳转超出身份批准范围。"
            : blockedMain
              ? "页面跳转到非公开地址，已阻止。"
              : "页面导航失败或超时。",
        );
      }
      if (authentication) {
        assertApprovedUrl(page.url(), authentication.profile);
        const prefix = authentication.profile.loginUrlPrefix;
        if (
          response?.status() === 401 ||
          (prefix && page.url().startsWith(prefix))
        )
          throw new AppError("AUTH_REQUIRED", "登录已失效，请重新登录。", 409);
        if (response?.status() === 403)
          throw new AppError(
            "ACCESS_DENIED",
            "该页面拒绝访问，请检查账号权限。",
          );
      }
      if (!response || !response.ok())
        throw new AppError(
          `HTTP_${response?.status() ?? "ERROR"}`,
          `目标页面返回 HTTP ${response?.status() ?? "错误"}。`,
        );
      if (authentication) {
        const selector =
          authentication.successSelector ||
          authentication.profile.successSelector;
        try {
          await page.evaluate((css) => {
            document.querySelector(css);
          }, selector);
          const marker = page.locator(`css=${selector}`);
          await marker.first().waitFor({
            state: "visible",
            timeout: this.options.targetTimeoutMs ?? 10_000,
          });
          if ((await marker.count()) !== 1 || !(await marker.isVisible()))
            throw new Error();
        } catch {
          throw new AppError(
            "AUTH_UNVERIFIED",
            "无法确认登录，请检查成功标记或重新授权。",
            409,
          );
        }
        authenticated = true;
      }
      return await operation(page);
    } catch (error) {
      if (timedOut)
        throw new AppError(
          "CHECK_TIMEOUT",
          "本次采集超过总等待上限，已关闭浏览器上下文。",
        );
      throw error;
    } finally {
      try {
        if (authenticated && authentication && activePage && !timedOut) {
          // Session loss can happen while extraction is sampling or taking a
          // screenshot. Check again before either content or state can escape.
          await this.assertCurrentAuthentication(activePage, authentication);
          if (authentication.onState) {
            const state = approvedState(
              await context.storageState({ indexedDB: true }),
              authentication.profile,
            );
            await this.assertCurrentAuthentication(activePage, authentication);
            authentication.onState(state);
          }
        }
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
  }
  private async assertCurrentAuthentication(
    page: Page,
    authentication: BrowserAuthentication,
  ) {
    assertApprovedUrl(page.url(), authentication.profile);
    if (
      authentication.profile.loginUrlPrefix &&
      page.url().startsWith(authentication.profile.loginUrlPrefix)
    )
      throw new AppError("AUTH_REQUIRED", "登录已失效，请重新登录。", 409);
    const selector =
      authentication.successSelector || authentication.profile.successSelector;
    try {
      const marker = page.locator(`css=${selector}`);
      if ((await marker.count()) !== 1 || !(await marker.isVisible()))
        throw new Error();
    } catch {
      throw new AppError(
        "AUTH_UNVERIFIED",
        "无法确认登录，请检查成功标记或重新授权。",
        409,
      );
    }
  }
  async close() {
    const pending = this.launching;
    this.launching = undefined;
    if (pending) await (await pending).close();
  }
}
