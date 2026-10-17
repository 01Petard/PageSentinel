import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AccountAction,
  CaptureStatus,
  CaptureSummary,
} from "../../../shared/types.js";
import { AppError } from "../errors.js";
import type { AuthProfileService } from "./auth-profile-service.js";

const terminal = new Set<CaptureStatus>([
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
interface Capture extends CaptureSummary {
  revision: number;
  pairHash?: string;
  helperHash?: string;
  heartbeatAt?: number;
  submitted: boolean;
  action: AccountAction;
}
export class LoginCaptureService {
  private sessions = new Map<string, Capture>();
  private timer: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<unknown>>();
  constructor(
    private profiles: AuthProfileService,
    private now = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), 2000);
    this.timer.unref();
  }
  private finish(
    c: Capture,
    status: CaptureStatus,
    errorCode: string | null = null,
  ) {
    c.status = status;
    c.errorCode = errorCode;
    c.pairHash = undefined;
    c.helperHash = undefined;
  }
  private sweep() {
    const now = this.now();
    for (const [id, c] of this.sessions) {
      if (terminal.has(c.status)) {
        if (now > c.expiresAt + 10 * 60_000) this.sessions.delete(id);
        continue;
      }
      if (now >= c.expiresAt) {
        this.finish(c, "EXPIRED");
        continue;
      }
      if (c.heartbeatAt !== undefined && now - c.heartbeatAt >= 30_000) {
        this.finish(c, "FAILED", "HELPER_DISCONNECTED");
        continue;
      }
      try {
        if (this.profiles.get(c.profileId).revision !== c.revision)
          this.finish(c, "CANCELLED", "AUTH_REVISION_CHANGED");
      } catch {
        this.finish(c, "CANCELLED", "AUTH_REVISION_CHANGED");
      }
    }
  }
  private session(id: string) {
    this.sweep();
    const c = this.sessions.get(id);
    if (!c)
      throw new AppError(
        "CAPTURE_NOT_FOUND",
        "登录会话不存在或服务已重启，请重新创建。",
        404,
      );
    return c;
  }
  private summary(c: Capture): CaptureSummary {
    return {
      id: c.id,
      profileId: c.profileId,
      status: c.status,
      expiresAt: c.expiresAt,
      errorCode: c.errorCode,
    };
  }
  create(profileId: string, action: AccountAction) {
    const profile = this.profiles.get(profileId);
    this.sweep();
    const active = [...this.sessions.values()].filter(
      (c) => !terminal.has(c.status),
    );
    if (active.length >= 2 || active.some((c) => c.profileId === profileId))
      throw new AppError(
        "CAPTURE_LIMIT",
        "最多同时打开两个登录会话，每个身份只能有一个。",
        409,
      );
    const pairingCode = randomBytes(32).toString("base64url");
    const c: Capture = {
      id: randomUUID(),
      profileId,
      revision: profile.revision,
      status: "WAITING_HELPER",
      expiresAt: this.now() + 10 * 60_000,
      errorCode: null,
      pairHash: hash(pairingCode),
      submitted: false,
      action,
    };
    this.sessions.set(c.id, c);
    return { ...this.summary(c), pairingCode };
  }
  get(id: string) {
    return this.summary(this.session(id));
  }
  cancel(id: string) {
    const c = this.session(id);
    if (!terminal.has(c.status)) this.finish(c, "CANCELLED");
    return this.summary(c);
  }
  save(id: string) {
    const c = this.session(id);
    if (c.status !== "LOGGING_IN")
      throw new AppError(
        "CAPTURE_NOT_READY",
        "请先在本机连接助手并完成登录。",
        409,
      );
    c.status = "SAVE_REQUESTED";
    return this.summary(c);
  }
  pair(code: string) {
    this.sweep();
    const c = [...this.sessions.values()].find(
      (c) => c.pairHash === hash(code) && c.status === "WAITING_HELPER",
    );
    if (!c)
      throw new AppError(
        "PAIRING_REJECTED",
        "配对码无效、已使用或已过期。",
        401,
      );
    c.pairHash = undefined;
    const helperToken = randomBytes(32).toString("base64url");
    c.helperHash = hash(helperToken);
    c.heartbeatAt = this.now();
    c.status = "LOGGING_IN";
    const p = this.profiles.get(c.profileId);
    return {
      ...this.summary(c),
      helperToken,
      profile: {
        loginUrl: p.loginUrl,
        verificationUrl: p.verificationUrl,
        allowedHosts: p.allowedHosts,
        successSelector: p.successSelector,
        loginUrlPrefix: p.loginUrlPrefix,
      },
    };
  }
  private authorize(id: string, token: string) {
    const c = this.session(id);
    if (!c.helperHash || hash(token) !== c.helperHash || terminal.has(c.status))
      throw new AppError("HELPER_UNAUTHORIZED", "助手会话无效或已结束。", 401);
    c.heartbeatAt = this.now();
    return c;
  }
  poll(id: string, token: string) {
    return this.summary(this.authorize(id, token));
  }
  cancelHelper(id: string, token: string) {
    this.authorize(id, token);
    return this.cancel(id);
  }
  submit(id: string, token: string, input: unknown) {
    const c = this.authorize(id, token);
    if (c.submitted || c.status !== "SAVE_REQUESTED") {
      if (!c.submitted) this.finish(c, "FAILED", "SAVE_NOT_REQUESTED");
      throw new AppError(
        "SAVE_NOT_REQUESTED",
        "必须先在管理页面确认保存，且只能提交一次。",
        409,
      );
    }
    c.submitted = true;
    c.status = "VERIFYING";
    let resolveResult!: (result: CaptureSummary) => void;
    let rejectResult!: (error: AppError) => void;
    const result = new Promise<CaptureSummary>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const promise = this.profiles
      .importState(
        c.profileId,
        input,
        c.action,
        "CAPTURE",
        c.revision,
        () => {
          this.sweep();
          return c.status === "VERIFYING";
        },
        () => {
          this.finish(c, "COMPLETED");
          // Credential commit is complete. Per-task recovery may need many more
          // browser visits; it must not hold the helper's upload response open.
          resolveResult(this.summary(c));
        },
      )
      .then(() => {
        this.finish(c, "COMPLETED");
        return this.summary(c);
      })
      .catch((error) => {
        if (!terminal.has(c.status))
          this.finish(
            c,
            "FAILED",
            error instanceof AppError ? error.code : "VERIFICATION_FAILED",
          );
        if (c.status === "COMPLETED") return this.summary(c);
        rejectResult(
          new AppError(
            c.errorCode ?? "CAPTURE_CANCELLED",
            "部署端验证失败或登录会话已结束，原身份未被替换。",
            409,
          ),
        );
        return this.summary(c);
      });
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return result;
  }
  async stop() {
    clearInterval(this.timer);
    for (const c of this.sessions.values())
      if (!terminal.has(c.status)) this.finish(c, "CANCELLED");
    await Promise.allSettled([...this.pending]);
    this.sessions.clear();
  }
}
