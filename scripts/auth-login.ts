import { chromium, type Browser, type Page } from "playwright";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { AuthProfileInput, CaptureSummary } from "../shared/types.js";
import { assertPublicUrl } from "../server/src/monitor/network.js";
import {
  assertApprovedUrl,
  approvedState,
} from "../server/src/auth/state-parser.js";
import { AppError } from "../server/src/errors.js";

export function helperServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("HELPER_SERVER", "请提供有效的服务地址。", 400);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new AppError(
      "HELPER_SERVER",
      "助手仅连接 HTTPS 或本机 loopback HTTP 服务，请只填写服务根地址。",
      400,
    );
  return url.origin;
}
interface HelperOptions {
  signal?: AbortSignal;
  launch?: () => Promise<Browser>;
  validateUrl?: (url: string) => Promise<void>;
  onWindow?: (page: Page) => Promise<void>;
}
export async function runLoginHelper(
  serverInput: string,
  pairingCode: string,
  options: HelperOptions = {},
) {
  const server = helperServer(serverInput);
  const call = async <T>(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
  ): Promise<T> => {
    const response = await fetch(`${server}/api${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(method === "POST" && token ? 90_000 : 8000),
        ...(options.signal ? [options.signal] : []),
      ]),
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "HELPER_REJECTED",
        "服务已拒绝此助手操作，请回到管理页检查会话状态。",
        response.status,
      );
    }
    return response.json() as Promise<T>;
  };
  const paired = await call<
    CaptureSummary & { helperToken: string; profile: AuthProfileInput }
  >("/auth-captures/pair", "POST", { pairingCode });
  pairingCode = "";
  let browser: Browser | undefined,
    completed = false;
  const path = `/auth-captures/${encodeURIComponent(paired.id)}/helper`;
  let upload: Promise<CaptureSummary> | undefined, uploadError: unknown;
  let uploadDone = false,
    lastContact = Date.now();
  try {
    browser = await (
      options.launch ??
      (() => chromium.launch({ headless: false, chromiumSandbox: true }))
    )();
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const validate = options.validateUrl ?? assertPublicUrl;
    let closed = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      let main = request.isNavigationRequest(),
        owner: Page | undefined;
      if (main) {
        try {
          const frame = request.frame();
          main = !frame.parentFrame();
          owner = frame.page();
        } catch {
          /* Initial popup navigation can precede its Page/Frame event. */
        }
      }
      try {
        await validate(request.url());
        if (main) assertApprovedUrl(request.url(), paired.profile);
        await route.continue();
      } catch {
        if (main && !owner)
          context.once("page", (popup) => {
            void popup.close().catch(() => {});
          });
        await route.abort("blockedbyclient").catch(() => {});
        if (main && owner) await owner.close().catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", (ws) => ws.close());
    const page = await context.newPage();
    page.on("close", () => {
      closed = true;
    });
    await validate(paired.profile.loginUrl);
    assertApprovedUrl(paired.profile.loginUrl, paired.profile);
    await page.goto(paired.profile.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await options.onWindow?.(page);
    while (
      !closed &&
      Date.now() < paired.expiresAt &&
      !options.signal?.aborted
    ) {
      if (uploadDone) {
        if (uploadError) throw uploadError;
        completed = true;
        break;
      }
      try {
        const status = await call<CaptureSummary>(
          path,
          "GET",
          undefined,
          paired.helperToken,
        );
        lastContact = Date.now();
        if (["CANCELLED", "EXPIRED", "FAILED"].includes(status.status)) break;
        if (status.status === "SAVE_REQUESTED" && !upload) {
          const state = approvedState(
            await context.storageState({ indexedDB: true }),
            paired.profile,
          );
          upload = call<CaptureSummary>(
            path,
            "POST",
            state,
            paired.helperToken,
          );
          void upload
            .then(() => {
              uploadDone = true;
            })
            .catch((error) => {
              uploadError = error;
              uploadDone = true;
            });
        }
      } catch (error) {
        if (error instanceof AppError) {
          if (upload) {
            await upload;
            completed = true;
            break;
          }
          if (error.statusCode === 401 || error.statusCode === 404) break;
          throw error;
        }
        if (Date.now() - lastContact >= 30_000)
          throw new AppError(
            "HELPER_DISCONNECTED",
            "与服务连续失联，登录窗口已关闭。",
            503,
          );
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 2000);
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return { completed };
  } finally {
    if (!completed)
      await call(path, "DELETE", undefined, paired.helperToken).catch(() => {});
    await browser?.close();
    if (upload) await upload.catch(() => {});
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--server")
    throw new AppError(
      "HELPER_USAGE",
      "用法：npm run auth:login -- --server <服务根地址>；配对码在交互提示中输入。",
      400,
    );
  helperServer(args[1]);
  if (!process.stdin.isTTY)
    throw new AppError("HELPER_TTY", "请在本机交互终端运行助手。", 400);
  const quiet = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output: quiet,
    terminal: true,
  });
  let code: string;
  process.stdout.write("一次性配对码（输入不回显）：");
  try {
    code = (await input.question("")).trim();
  } finally {
    input.close();
    process.stdout.write("\n");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(
      "正在打开专用窗口。请自行登录 / MFA，然后回到 PageSentinel 点击“保存登录状态”。",
    );
    const result = await runLoginHelper(args[1], code, {
      signal: controller.signal,
    });
    console.log(
      result.completed
        ? "部署端验证通过，状态已加密保存。"
        : "登录会话已结束，未保存状态。",
    );
  } finally {
    code = "";
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error(
      "登录助手未能完成，请检查服务地址、配对状态和完整 Chromium 安装；原身份保持不变。",
    );
    process.exitCode = 1;
  });
