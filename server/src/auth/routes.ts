import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { AuthProfileService } from "./auth-profile-service.js";
import { STATE_LIMIT } from "./state-parser.js";
import type { LoginCaptureService } from "./login-capture.js";

export function authId(params: unknown) {
  const parsed = z.object({ id: z.uuid() }).safeParse(params);
  if (!parsed.success)
    throw new AppError("INVALID_ID", "身份或会话 ID 不合法。", 400);
  return parsed.data.id;
}
export function registerAuthRoutes(
  app: FastifyInstance,
  profiles: AuthProfileService,
  captures: LoginCaptureService,
) {
  app.get("/api/auth-profiles", async () => profiles.list());
  app.post("/api/auth-profiles", async (r, reply) =>
    reply.code(201).send(await profiles.create(r.body)),
  );
  app.get("/api/auth-profiles/:id", async (r) =>
    profiles.get(authId(r.params)),
  );
  app.patch("/api/auth-profiles/:id", async (r) =>
    profiles.update(authId(r.params), r.body),
  );
  app.delete("/api/auth-profiles/:id", async (r, reply) => {
    profiles.delete(authId(r.params));
    return reply.code(204).send();
  });
  app.post(
    "/api/auth-profiles/:id/import",
    { bodyLimit: STATE_LIMIT },
    async (r) => {
      const body = z
        .strictObject({
          input: z.unknown(),
          accountAction: z.enum(["SAME_ACCOUNT", "SWITCH_ACCOUNT"]),
        })
        .safeParse(r.body);
      if (!body.success)
        throw new AppError(
          "INVALID_AUTH_INPUT",
          "请提供登录状态并明确账号更新方式。",
          400,
        );
      return profiles.importState(
        authId(r.params),
        body.data.input,
        body.data.accountAction,
      );
    },
  );
  app.post("/api/auth-profiles/:id/verify", async (r) =>
    profiles.verify(authId(r.params)),
  );
  app.post("/api/auth-profiles/:id/revoke", async (r) =>
    profiles.revoke(authId(r.params)),
  );
  app.post("/api/auth-profiles/:id/captures", async (r, reply) => {
    const body = z
      .strictObject({
        accountAction: z.enum(["SAME_ACCOUNT", "SWITCH_ACCOUNT"]),
      })
      .safeParse(r.body);
    if (!body.success)
      throw new AppError(
        "ACCOUNT_ACTION_REQUIRED",
        "请选择同一账号更新或切换账号。",
        400,
      );
    return reply
      .code(201)
      .send(captures.create(authId(r.params), body.data.accountAction));
  });
  app.get("/api/auth-captures/:id", async (r) =>
    captures.get(authId(r.params)),
  );
  app.delete("/api/auth-captures/:id", async (r) =>
    captures.cancel(authId(r.params)),
  );
  app.post("/api/auth-captures/:id/save", async (r) =>
    captures.save(authId(r.params)),
  );
  app.post(
    "/api/auth-captures/pair",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r) => {
      const body = z
        .strictObject({ pairingCode: z.string().regex(/^[\w-]{43}$/) })
        .safeParse(r.body);
      if (!body.success)
        throw new AppError("PAIRING_REJECTED", "配对码格式无效。", 401);
      return captures.pair(body.data.pairingCode);
    },
  );
  const token = (value: string | undefined) => {
    if (!value || !/^Bearer [\w-]{43}$/.test(value))
      throw new AppError("HELPER_UNAUTHORIZED", "助手令牌无效。", 401);
    return value.slice(7);
  };
  app.get("/api/auth-captures/:id/helper", async (r) =>
    captures.poll(authId(r.params), token(r.headers.authorization)),
  );
  app.delete("/api/auth-captures/:id/helper", async (r) =>
    captures.cancelHelper(authId(r.params), token(r.headers.authorization)),
  );
  app.post(
    "/api/auth-captures/:id/helper",
    { bodyLimit: STATE_LIMIT },
    async (r) =>
      captures.submit(authId(r.params), token(r.headers.authorization), r.body),
  );
}
