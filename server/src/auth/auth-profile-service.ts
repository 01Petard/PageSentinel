import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuthProfileInput,
  AuthProfileSummary,
  AccountAction,
  AuthRunStatus,
  CheckSource,
} from "../../../shared/types.js";
import type { Db } from "../db/database.js";
import type { BrowserCollector } from "../monitor/browser.js";
import { AppError } from "../errors.js";
import { decryptState, encryptState } from "./crypto.js";
import {
  normalizeAuthState,
  validHost,
  assertApprovedUrl,
} from "./state-parser.js";
import type { StorageState } from "./types.js";

const configSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  loginUrl: z.string().max(4096),
  verificationUrl: z.string().max(4096),
  allowedHosts: z
    .array(z.string().refine(validHost))
    .min(1)
    .max(20)
    .refine((hosts) => new Set(hosts).size === hosts.length),
  successSelector: z.string().trim().min(1).max(2000),
  loginUrlPrefix: z.string().max(4096).optional(),
});
export class AuthProfileService {
  withIdentity: <T>(id: string, operation: () => Promise<T>) => Promise<T> =
    async (_id, operation) => operation();
  onVerified: (id: string) => Promise<void> = async () => {};
  runVerification: (
    id: string,
    profile: AuthProfileInput,
    state: StorageState,
  ) => ReturnType<BrowserCollector["verifyAuthentication"]>;
  constructor(
    readonly db: Db,
    private browser: BrowserCollector,
    private key?: Buffer,
  ) {
    this.runVerification = (_id, profile, state) =>
      browser.verifyAuthentication(profile, state);
    if (key)
      for (const row of db
        .prepare("SELECT * FROM auth_profiles WHERE ciphertext IS NOT NULL")
        .all() as any[]) {
        try {
          decryptState(row.id, row.revision, row, key);
        } catch {
          db.prepare(
            "UPDATE auth_profiles SET status='NEEDS_LOGIN',error_code='AUTH_STATE_UNAVAILABLE' WHERE id=?",
          ).run(row.id);
        }
      }
  }
  assertEnabled() {
    if (!this.key)
      throw new AppError(
        "AUTH_DISABLED",
        "请先配置 ADMIN_TOKEN 和 AUTH_MASTER_KEY 后重启服务。",
        409,
      );
  }
  get(id: string): AuthProfileSummary {
    this.assertEnabled();
    const row = this.db
      .prepare(
        "SELECT p.*, (SELECT count(*) FROM monitors m WHERE m.auth_profile_id=p.id) AS bound_count FROM auth_profiles p WHERE id=?",
      )
      .get(id) as any;
    if (!row) throw new AppError("NOT_FOUND", "登录身份不存在。", 404);
    return this.summary(row);
  }
  private summary(row: any): AuthProfileSummary {
    return {
      ...JSON.parse(row.config_json),
      id: row.id,
      source: row.source,
      status: row.status,
      revision: row.revision,
      stateVersion: row.state_version,
      verifiedAt: row.verified_at,
      errorCode: row.error_code,
      boundCount: row.bound_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  list() {
    this.assertEnabled();
    return (
      this.db
        .prepare(
          `SELECT p.*,COALESCE(m.bound_count,0) AS bound_count FROM auth_profiles p
      LEFT JOIN (SELECT auth_profile_id,count(*) AS bound_count FROM monitors GROUP BY auth_profile_id) m ON m.auth_profile_id=p.id
      ORDER BY p.created_at DESC`,
        )
        .all() as any[]
    ).map((row) => this.summary(row));
  }
  async validateConfig(input: unknown): Promise<AuthProfileInput> {
    const parsed = configSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "INVALID_AUTH_PROFILE",
        "身份名称、批准主机或验证规则不合法。",
        400,
      );
    const config = parsed.data;
    for (const raw of [
      config.loginUrl,
      config.verificationUrl,
      ...(config.loginUrlPrefix ? [config.loginUrlPrefix] : []),
    ]) {
      assertApprovedUrl(raw, config);
      await this.browser.validateUrl(raw);
    }
    return config;
  }
  async create(input: unknown) {
    this.assertEnabled();
    const config = await this.validateConfig(input),
      id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO auth_profiles(id,config_json,created_at,updated_at) VALUES(?,?,?,?)",
      )
      .run(id, JSON.stringify(config), now, now);
    return this.get(id);
  }
  async update(id: string, input: unknown) {
    const updated = await this.withIdentity(id, async () => {
      const before = this.get(id),
        patch = configSchema.partial().safeParse(input);
      if (!patch.success)
        throw new AppError("INVALID_AUTH_PROFILE", "身份配置不合法。", 400);
      const config = await this.validateConfig({
        name: before.name,
        loginUrl: before.loginUrl,
        verificationUrl: before.verificationUrl,
        allowedHosts: before.allowedHosts,
        successSelector: before.successSelector,
        ...(before.loginUrlPrefix
          ? { loginUrlPrefix: before.loginUrlPrefix }
          : {}),
        ...patch.data,
      });
      const changed =
        config.loginUrl !== before.loginUrl ||
        config.verificationUrl !== before.verificationUrl ||
        JSON.stringify(config.allowedHosts) !==
          JSON.stringify(before.allowedHosts) ||
        config.successSelector !== before.successSelector ||
        (config.loginUrlPrefix || "") !== (before.loginUrlPrefix || "");
      let state: StorageState | undefined;
      if (changed && before.status !== "EMPTY") {
        const current = normalizeAuthState(this.loadState(id), config);
        state = (await this.runVerification(id, config, current)).state;
      }
      if (this.get(id).revision !== before.revision)
        throw new AppError(
          "AUTH_REVISION_CHANGED",
          "授权已变化，请重新操作。",
          409,
        );
      const revision = before.revision + Number(changed);
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE auth_profiles SET config_json=?,revision=?,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(config), revision, Date.now(), id);
        if (state) this.writeState(id, revision, state);
      })();
      return { recover: Boolean(state) };
    });
    if (updated.recover) await this.onVerified(id);
    return this.get(id);
  }
  loadState(id: string): StorageState {
    const profile = this.get(id);
    if (profile.status !== "READY")
      throw new AppError("AUTH_REQUIRED", "登录身份不可用，请重新授权。", 409);
    const row = this.db
      .prepare("SELECT ciphertext,nonce,tag FROM auth_profiles WHERE id=?")
      .get(id) as any;
    try {
      return decryptState(id, profile.revision, row, this.key!);
    } catch (error) {
      this.db
        .prepare(
          "UPDATE auth_profiles SET status='NEEDS_LOGIN',error_code='AUTH_STATE_UNAVAILABLE' WHERE id=?",
        )
        .run(id);
      throw error;
    }
  }
  writeState(id: string, revision: number, state: StorageState) {
    const encrypted = encryptState(id, revision, state, this.key!);
    this.db
      .prepare(
        "UPDATE auth_profiles SET ciphertext=?,nonce=?,tag=?,state_version=state_version+1,verified_at=?,error_code=NULL,status='READY',updated_at=? WHERE id=? AND revision=?",
      )
      .run(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        Date.now(),
        Date.now(),
        id,
        revision,
      );
  }
  async importState(
    id: string,
    input: unknown,
    accountAction?: AccountAction,
    source: "IMPORT" | "CAPTURE" = "IMPORT",
    expectedRevision?: number,
    canSave: () => boolean = () => true,
    onCommit: () => void = () => {},
  ) {
    await this.withIdentity(id, async () => {
      const profile = this.get(id);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== profile.revision
      )
        throw new AppError(
          "AUTH_REVISION_CHANGED",
          "授权已变化，请重新配对。",
          409,
        );
      if (
        accountAction !== "SAME_ACCOUNT" &&
        accountAction !== "SWITCH_ACCOUNT"
      )
        throw new AppError(
          "ACCOUNT_ACTION_REQUIRED",
          "请选择同一账号更新或切换账号。",
          400,
        );
      const state = normalizeAuthState(input, profile);
      const verified = await this.runVerification(id, profile, state);
      if (this.get(id).revision !== profile.revision || !canSave())
        throw new AppError(
          "AUTH_REVISION_CHANGED",
          "授权或采集会话已变化，请重新操作。",
          409,
        );
      this.db.transaction(() => {
        const revision = profile.revision + 1;
        this.db
          .prepare("UPDATE auth_profiles SET revision=?,source=? WHERE id=?")
          .run(revision, source, id);
        this.writeState(id, revision, verified.state);
        this.authorizationChanged(
          id,
          accountAction === "SWITCH_ACCOUNT",
          false,
        );
      })();
      onCommit();
    });
    await this.onVerified(id);
    return this.get(id);
  }
  async verify(id: string) {
    await this.withIdentity(id, async () => {
      const profile = this.get(id);
      const row = this.db
        .prepare("SELECT * FROM auth_profiles WHERE id=?")
        .get(id) as any;
      if (!row.ciphertext)
        throw new AppError(
          "AUTH_REQUIRED",
          "请先导入状态或在专用窗口登录。",
          409,
        );
      const verified = await this.runVerification(
        id,
        profile,
        decryptState(id, profile.revision, row, this.key!),
      );
      if (this.get(id).revision !== profile.revision)
        throw new AppError("AUTH_REVISION_CHANGED", "授权已变化。", 409);
      this.writeState(id, profile.revision, verified.state);
    });
    await this.onVerified(id);
    return this.get(id);
  }
  revoke(id: string) {
    this.get(id);
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE auth_profiles SET status='EMPTY',revision=revision+1,ciphertext=NULL,nonce=NULL,tag=NULL,verified_at=NULL,error_code=NULL,updated_at=? WHERE id=?",
        )
        .run(Date.now(), id);
      this.authorizationChanged(id, false, true);
    })();
    return this.get(id);
  }
  delete(id: string) {
    if (this.get(id).boundCount)
      throw new AppError("AUTH_IN_USE", "请先解除所有任务的身份绑定。", 409);
    this.db.prepare("DELETE FROM auth_profiles WHERE id=?").run(id);
  }
  blockMonitor(
    id: string,
    code: AuthRunStatus,
    source: CheckSource,
    durationMs = 0,
    alert = true,
    checked = true,
  ) {
    const row = this.db
      .prepare(
        "SELECT auth_profile_id,auth_blocked_code FROM monitors WHERE id=?",
      )
      .get(id) as any;
    if (!row?.auth_profile_id) return;
    const now = Date.now();
    if (checked)
      this.db
        .prepare("UPDATE monitors SET last_checked_at=? WHERE id=?")
        .run(now, id);
    if (row.auth_blocked_code) return;
    this.db
      .prepare(
        "UPDATE monitors SET auth_blocked_code=?,auth_blocked_at=? WHERE id=?",
      )
      .run(code, now, id);
    this.db
      .prepare(
        "INSERT INTO check_runs(monitor_id,status,duration_ms,checked_at,source,summary,error_code,error_message) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        code,
        durationMs,
        now,
        source,
        "需要重新登录或检查登录成功标记。",
        code,
        "登录验证未通过，已保留上次成功内容。",
      );
    if (alert)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO auth_alerts(monitor_id,profile_id,blocked_at,next_attempt_at,created_at) VALUES(?,?,?,?,?)",
        )
        .run(id, row.auth_profile_id, now, now, now);
  }
  invalidate(id: string, revision: number, attemptedMonitorId?: string) {
    if (this.get(id).revision !== revision) return;
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE auth_profiles SET status='NEEDS_LOGIN',error_code='AUTH_REQUIRED' WHERE id=?",
        )
        .run(id);
      for (const row of this.db
        .prepare("SELECT id FROM monitors WHERE auth_profile_id=?")
        .all(id) as { id: string }[])
        if (row.id !== attemptedMonitorId)
          this.blockMonitor(row.id, "AUTH_REQUIRED", "AUTO", 0, true, false);
    })();
  }
  private authorizationChanged(id: string, reset: boolean, revoked: boolean) {
    const now = Date.now(),
      monitors = this.db
        .prepare("SELECT id FROM monitors WHERE auth_profile_id=?")
        .all(id) as { id: string }[];
    for (const monitor of monitors) {
      if (reset) {
        this.db
          .prepare(
            "UPDATE monitors SET baseline_snapshot_id=NULL,last_success_at=NULL,revision=revision+1 WHERE id=?",
          )
          .run(monitor.id);
        this.db
          .prepare("DELETE FROM seen_items WHERE monitor_id=?")
          .run(monitor.id);
        this.db
          .prepare("DELETE FROM monitor_previews WHERE monitor_id=?")
          .run(monitor.id);
      }
      if (revoked)
        this.db
          .prepare(
            "UPDATE monitors SET auth_blocked_code='AUTH_REQUIRED',auth_blocked_at=COALESCE(auth_blocked_at,?) WHERE id=?",
          )
          .run(now, monitor.id);
      if (revoked)
        this.db
          .prepare(
            "DELETE FROM auth_alerts WHERE monitor_id=? AND status='PENDING'",
          )
          .run(monitor.id);
      this.db
        .prepare(
          "INSERT INTO check_runs(monitor_id,status,duration_ms,checked_at,source,summary) VALUES(?,?,0,?,'AUTH_CONTROL',?)",
        )
        .run(
          monitor.id,
          revoked ? "AUTH_REVOKED" : "AUTH_UPDATED",
          now,
          revoked
            ? "登录状态已主动清除。"
            : reset
              ? "已切换账号，下一次成功采集重新建立基线。"
              : "同账号授权已更新，保留基线。",
        );
    }
  }
}
