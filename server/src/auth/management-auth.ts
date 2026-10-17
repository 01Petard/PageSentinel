import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import { AppError } from "../errors.js";
import { parseMasterKey } from "./crypto.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const cookieName = "ps_admin";
export function installManagementAuth(
  app: FastifyInstance,
  db: Db,
  options: { adminToken?: string; authMasterKey?: string; ntfyTarget?: string },
) {
  const persisted = Boolean(
    (
      db
        .prepare("SELECT auth_required FROM app_security WHERE id=1")
        .get() as any
    ).auth_required,
  );
  const configured = Boolean(options.adminToken || options.authMasterKey);
  let key: Buffer | undefined;
  if (persisted || configured) {
    if (
      !options.adminToken ||
      Buffer.byteLength(options.adminToken) < 32 ||
      !options.authMasterKey
    )
      throw new AppError(
        "AUTH_CONFIG",
        "已启用身份保护，必须配置至少 32 字节的 ADMIN_TOKEN 和独立 AUTH_MASTER_KEY。",
        503,
      );
    key = parseMasterKey(options.authMasterKey);
    db.prepare("UPDATE app_security SET auth_required=1 WHERE id=1").run();
  }
  const required = Boolean(key);
  const sessions = new Map<string, { csrf: string; expires: number }>();
  function session(request: FastifyRequest) {
    const value = request.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!value) return;
    const hash = digest(value).toString("hex"),
      item = sessions.get(hash);
    if (item && item.expires > Date.now()) return { ...item, hash };
    sessions.delete(hash);
  }
  app.addHook("onRequest", async (request, reply) => {
    // Fastify decodes static route segments; use its matched pattern so encoded
    // aliases cannot turn a private API into an apparently non-API request.
    const path = request.routeOptions.url ?? request.url.split("?")[0];
    if (!path.startsWith("/api/") || path === "/api/health") return;
    reply.header("cache-control", "no-store");
    const helperRoute =
      /^\/api\/auth-captures\/[^/]+\/helper$/.test(path) ||
      path === "/api/auth-captures/pair";
    if (
      helperRoute ||
      (path === "/api/admin/session" &&
        ["GET", "POST"].includes(request.method))
    )
      return;
    if (!required) return;
    const current = session(request);
    if (!current) throw new AppError("UNAUTHORIZED", "请先解锁管理入口。", 401);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers["x-csrf-token"] !== current.csrf
    )
      throw new AppError(
        "CSRF_REQUIRED",
        "管理会话已变化，请刷新页面后重试。",
        403,
      );
  });
  app.get("/api/admin/session", async (request) => {
    const current = session(request);
    return {
      required,
      unlocked: !required || Boolean(current),
      ...(current ? { csrfToken: current.csrf } : {}),
      ...(!required || current
        ? { ntfyConfigured: Boolean(options.ntfyTarget) }
        : {}),
    };
  });
  app.post(
    "/api/admin/session",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!required) return { required: false, unlocked: true };
      const token = (request.body as any)?.token;
      if (
        typeof token !== "string" ||
        !timingSafeEqual(digest(token), digest(options.adminToken!))
      )
        throw new AppError("UNAUTHORIZED", "管理令牌不正确。", 401);
      const value = randomBytes(32).toString("base64url"),
        csrf = randomBytes(32).toString("base64url");
      const current = session(request);
      if (current) sessions.delete(current.hash);
      for (const [hash, item] of sessions)
        if (item.expires <= Date.now()) sessions.delete(hash);
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
      sessions.set(digest(value).toString("hex"), {
        csrf,
        expires: Date.now() + 12 * 60 * 60_000,
      });
      const secure =
        request.protocol === "https" ||
        request.headers.origin?.startsWith("https://");
      reply.header(
        "set-cookie",
        `${cookieName}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`,
      );
      return {
        required: true,
        unlocked: true,
        csrfToken: csrf,
        ntfyConfigured: Boolean(options.ntfyTarget),
      };
    },
  );
  app.delete("/api/admin/session", async (request, reply) => {
    const current = session(request);
    if (current) sessions.delete(current.hash);
    reply.header(
      "set-cookie",
      `${cookieName}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return reply.code(204).send();
  });
  app.addHook("onClose", async () => {
    sessions.clear();
  });
  return { required, key };
}
