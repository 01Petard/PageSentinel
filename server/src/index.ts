import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";
import { createApp } from "./app.js";

const config = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_HOST: z.string().max(253).optional(),
    DATA_DIR: z.string().default("./data"),
    CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
    NAVIGATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60_000)
      .default(20_000),
    TARGET_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(30_000)
      .default(10_000),
    STABILITY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(2000)
      .max(30_000)
      .default(10_000),
    SAMPLE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(200)
      .max(3000)
      .default(1000),
    NTFY_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    NTFY_TOKEN: z.string().optional(),
    ADMIN_TOKEN: z.string().optional(),
    AUTH_MASTER_KEY: z.string().optional(),
  })
  .safeParse(process.env);
if (!config.success) {
  console.error("环境配置无效，请检查 .env 中的地址、端口、并发数和超时范围。");
  process.exit(1);
}
const c = config.data;
if (
  c.NTFY_URL &&
  (!["http:", "https:"].includes(new URL(c.NTFY_URL).protocol) ||
    new URL(c.NTFY_URL).username ||
    new URL(c.NTFY_URL).password)
) {
  console.error("NTFY_URL 必须为不含凭据的 HTTP(S) 地址。");
  process.exit(1);
}
const { app } = await createApp({
  databasePath: resolve(c.DATA_DIR, "pagesentinel.sqlite"),
  logger: true,
  concurrency: c.CHECK_CONCURRENCY,
  ntfyTarget: c.NTFY_URL,
  ntfyToken: c.NTFY_TOKEN,
  adminToken: c.ADMIN_TOKEN || undefined,
  authMasterKey: c.AUTH_MASTER_KEY || undefined,
  allowedHostnames: [c.HOST, ...(c.PUBLIC_HOST ? [c.PUBLIC_HOST] : [])].filter(
    (host) => host !== "0.0.0.0" && host !== "::",
  ),
  browserOptions: {
    navigationTimeoutMs: c.NAVIGATION_TIMEOUT_MS,
    targetTimeoutMs: c.TARGET_TIMEOUT_MS,
    stabilityTimeoutMs: c.STABILITY_TIMEOUT_MS,
    sampleIntervalMs: c.SAMPLE_INTERVAL_MS,
  },
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
try {
  await app.listen({ host: c.HOST, port: c.PORT });
} catch {
  console.error("服务启动失败，请检查监听地址和端口占用。");
  await app.close();
  process.exitCode = 1;
}
