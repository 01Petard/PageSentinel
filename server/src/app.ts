import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { openDatabase } from "./db/database.js";
import { BrowserCollector, type BrowserOptions } from "./monitor/browser.js";
import { MonitorService } from "./monitor/monitor-service.js";
import { Scheduler } from "./monitor/scheduler.js";
import { NotificationWorker } from "./notification/ntfy.js";
import { AppError } from "./errors.js";
import { validateInput, validatePatch, validateRule } from "./validation.js";
import { installManagementAuth } from "./auth/management-auth.js";
import { AuthProfileService } from "./auth/auth-profile-service.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthSessionService } from "./auth/auth-session-service.js";
import { LoginCaptureService } from "./auth/login-capture.js";

export interface AppOptions {
  databasePath?: string;
  collector?: BrowserCollector;
  browserOptions?: BrowserOptions;
  workers?: boolean;
  logger?: boolean;
  concurrency?: number;
  ntfyTarget?: string;
  ntfyToken?: string;
  staticRoot?: string;
  allowedHostnames?: string[];
  adminToken?: string;
  authMasterKey?: string;
}
export async function createApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
          ],
        }
      : false,
    bodyLimit: 64 * 1024,
    requestTimeout: 90_000,
  });
  const db = openDatabase(
    options.databasePath ?? resolve("data/pagesentinel.sqlite"),
  );
  const browser =
    options.collector ?? new BrowserCollector(options.browserOptions);
  await app.register(rateLimit, {
    // Polling several open views must not consume the manual-action allowance.
    max: (request) => (["GET", "HEAD"].includes(request.method) ? 600 : 180),
    keyGenerator: (request) =>
      `${request.ip}:${["GET", "HEAD"].includes(request.method) ? "read" : "write"}`,
    timeWindow: "1 minute",
  });
  app.addHook("onRequest", async (request) => {
    let hostname = "";
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      /* Reject malformed hosts. */
    }
    if (
      ![
        "127.0.0.1",
        "localhost",
        "[::1]",
        ...(options.allowedHostnames ?? []),
      ].includes(hostname)
    )
      throw new AppError(
        "INVALID_HOST",
        "访问主机名未配置，请使用本机地址或配置 PUBLIC_HOST。",
        403,
      );
    const origin = request.headers.origin;
    if (origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === request.headers.host;
      } catch {
        /* Invalid origins are rejected. */
      }
      if (!sameHost)
        throw new AppError("CROSS_ORIGIN", "不允许跨来源访问。", 403);
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });
  let security: ReturnType<typeof installManagementAuth>;
  try {
    security = installManagementAuth(app, db, options);
  } catch (error) {
    db.close();
    throw error;
  }
  const profiles = new AuthProfileService(db, browser, security.key);
  const authSessions = new AuthSessionService(profiles);
  const service = new MonitorService(db, browser, {
    concurrency: options.concurrency,
    authSessions,
  });
  profiles.withIdentity = (id, operation) =>
    authSessions.withLock(id, operation);
  profiles.runVerification = (id, profile, state) =>
    service.verifyProfile(id, profile, state);
  profiles.onVerified = (id) => service.recoverProfile(id);
  const scheduler = new Scheduler(db, service);
  const notifications = new NotificationWorker(db, {
    target: options.ntfyTarget,
    token: options.ntfyToken,
  });
  const captures = new LoginCaptureService(profiles);
  registerAuthRoutes(app, profiles, captures);
  app.setErrorHandler(
    (error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof AppError)
        return reply
          .code(error.statusCode)
          .send({ code: error.code, message: error.message });
      const status =
        error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
      return reply.code(status).send({
        code: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message:
          status === 500
            ? "服务处理失败，请查看运行环境和数据库状态。"
            : "请求格式不正确或请求过于频繁。",
      });
    },
  );
  const idFrom = (params: unknown) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(params);
    if (!parsed.success)
      throw new AppError("INVALID_ID", "任务 ID 不合法。", 400);
    return parsed.data.id;
  };
  const pageFrom = (query: unknown) => {
    const parsed = z
      .strictObject({
        pageIndex: z.coerce.number().int().min(1).max(1_000_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse(query);
    if (!parsed.success)
      throw new AppError("INVALID_PAGE", "分页参数不合法。", 400);
    return parsed.data;
  };
  app.get("/api/health", async () => ({
    status: "ok",
    ...(!security.required
      ? { ntfyConfigured: Boolean(options.ntfyTarget) }
      : {}),
  }));
  app.get("/api/settings", async () => service.settings());
  app.get("/api/updates", async (request) => {
    const parsed = z
      .strictObject({
        after: z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .safeParse(request.query);
    if (!parsed.success)
      throw new AppError("VALIDATION_ERROR", "消息游标不合法。", 400);
    return service.updates(parsed.data.after);
  });
  app.post("/api/monitors/check-all", async (_request, reply) =>
    reply.code(202).send(service.checkAll()),
  );
  app.get("/api/monitors", async () => service.list());
  app.post("/api/monitors/test", async (request) =>
    service.testRule(validateRule(request.body)),
  );
  app.post("/api/monitors", async (request, reply) => {
    const monitor = service.create(validateInput(request.body));
    void service.check(monitor.id, "CREATE").catch(() => {});
    return reply.code(201).send(service.get(monitor.id));
  });
  app.get("/api/monitors/:id", async (request) =>
    service.get(idFrom(request.params)),
  );
  app.patch("/api/monitors/:id", async (request) => {
    const id = idFrom(request.params),
      before = service.get(id);
    const updated = service.update(id, validatePatch(request.body));
    if (updated.revision !== before.revision && !updated.running)
      void service.check(id, "RULE_EDIT").catch(() => {});
    return service.get(id);
  });
  app.delete("/api/monitors/:id", async (request, reply) => {
    service.delete(idFrom(request.params));
    return reply.code(204).send();
  });
  app.post("/api/monitors/:id/check", async (request) =>
    service.check(idFrom(request.params)),
  );
  app.get("/api/monitors/:id/current", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.current(idFrom(request.params));
  });
  app.get("/api/monitors/:id/thumbnail", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return reply
      .type("image/jpeg")
      .send(service.thumbnail(idFrom(request.params)));
  });
  app.get("/api/monitors/:id/events", async (request) => {
    const p = pageFrom(request.query);
    return service.events(idFrom(request.params), p.pageIndex, p.pageSize);
  });
  app.get("/api/monitors/:id/checks", async (request) => {
    const p = pageFrom(request.query);
    return service.checks(idFrom(request.params), p.pageIndex, p.pageSize);
  });
  const staticRoot = options.staticRoot ?? resolve("dist/client");
  if (existsSync(resolve(staticRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: staticRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/") ||
      request.method !== "GET" ||
      !request.headers.accept?.includes("text/html")
        ? reply.code(404).send({ code: "NOT_FOUND", message: "资源不存在。" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    scheduler.stop();
    await captures.stop();
    await service.stop();
    await notifications.stop();
    await browser.close();
    db.close();
  });
  if (options.workers !== false) {
    scheduler.start();
    notifications.start();
  }
  return { app, service, db, scheduler, notifications, profiles, captures };
}
