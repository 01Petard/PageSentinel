import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";
import { monitorFromRow, eventFromRow, checkFromRow } from "../db/database.js";
import type {
  Monitor,
  MonitorInput,
  Rule,
  ExtractResult,
  ChangeDetail,
  RunStatus,
  PageResult,
  ChangeEvent,
  CheckRun,
  CheckSource,
  CurrentContent,
} from "../../../shared/types.js";
import { AppError } from "../errors.js";
import { validateInput, validatePatch } from "../validation.js";
import { compareText, unseenItems } from "./comparator.js";
import type { BrowserCollector } from "./browser.js";

// Spread each deadline in both directions, including retries and manual refreshes.
export function nextCheckAt(
  now: number,
  delayMs: number,
  random = Math.random,
): number {
  const sign = random() < 0.5 ? -1 : 1;
  const jitter = 5000 + Math.floor(random() * 5001);
  return now + delayMs + sign * jitter;
}

export class MonitorService {
  private batch?: Promise<void>;
  private refreshingAll = false;
  private inFlight = new Map<
    string,
    Promise<{ status?: RunStatus; discarded?: boolean }>
  >();
  private active = 0;
  private queue: (() => void)[] = [];
  private hostStarts = new Map<string, number>();
  private previews = new Set<Promise<ExtractResult>>();
  private stopping = false;
  readonly concurrency: number;
  constructor(
    private db: Db,
    private browser: BrowserCollector,
    private options: { concurrency?: number; hostDelayMs?: number } = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
  }
  get availableSlots() {
    return Math.max(0, this.concurrency - this.active - this.queue.length);
  }
  settings() {
    return { refreshingAll: this.refreshingAll };
  }
  checkAll() {
    if (this.stopping) throw new AppError("STOPPING", "服务正在退出。", 503);
    if (this.refreshingAll)
      throw new AppError(
        "ALREADY_RUNNING",
        "全部监控正在刷新，请等待完成。",
        409,
      );
    const ids = this.list().map((m) => m.id);
    this.refreshingAll = true;
    const run = async () => {
      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(this.concurrency, ids.length) },
          async () => {
            while (cursor < ids.length && !this.stopping) {
              const id = ids[cursor++];
              const existing = this.inFlight.get(id);
              if (existing) await existing.catch(() => {});
              if (this.stopping) break;
              while (!this.stopping) {
                try {
                  await this.check(id, "MANUAL_BATCH");
                  break;
                } catch (error) {
                  if (error instanceof AppError && error.code === "BUSY") {
                    // A full preview queue must delay a forced refresh, not silently skip it.
                    const pending = [
                      ...this.inFlight.values(),
                      ...this.previews,
                    ];
                    if (pending.length) {
                      await Promise.race(pending).catch(() => {});
                      continue;
                    }
                  }
                  if (
                    error instanceof AppError &&
                    error.code === "ALREADY_RUNNING"
                  ) {
                    await this.inFlight.get(id)?.catch(() => {});
                    continue;
                  }
                  // Deleted tasks are skipped; collection failures are recorded by check.
                  break;
                }
              }
            }
          },
        ),
      );
    };
    this.batch = run().finally(() => {
      this.refreshingAll = false;
    });
    return { total: ids.length };
  }
  current(id: string): CurrentContent {
    const monitor = this.get(id);
    const row = this.db
      .prepare(
        `SELECT s.content_json, s.created_at, m.last_success_at,
      p.captured_at AS thumbnail_at FROM monitors m
      LEFT JOIN snapshots s ON s.id = m.baseline_snapshot_id
      LEFT JOIN monitor_previews p ON p.monitor_id = m.id WHERE m.id = ?`,
      )
      .get(id) as any;
    return {
      content: row.content_json ? JSON.parse(row.content_json) : null,
      capturedAt: monitor.baselineSnapshotId
        ? (row.last_success_at ?? row.created_at)
        : null,
      thumbnailAt: row.thumbnail_at ?? null,
    };
  }
  thumbnail(id: string): Buffer {
    this.get(id);
    const row = this.db
      .prepare("SELECT image FROM monitor_previews WHERE monitor_id = ?")
      .get(id) as { image: Buffer } | undefined;
    if (!row)
      throw new AppError(
        "NOT_FOUND",
        "尚未生成页面缩略图，请先成功检查一次。",
        404,
      );
    return row.image;
  }
  updates(after?: number) {
    const rows = this.db
      .prepare(
        `SELECT c.*, json_extract(m.config_json, '$.name') AS monitor_name,
      json_extract(m.config_json, '$.url') AS monitor_url
      FROM check_runs c JOIN monitors m ON m.id = c.monitor_id
      WHERE c.status IN ('BASELINE','UNCHANGED','CHANGED','FAILED')
      ${after === undefined ? "ORDER BY c.id DESC LIMIT 20" : "AND c.id > ? ORDER BY c.id ASC LIMIT 101"}`,
      )
      .all(...(after === undefined ? [] : [after])) as any[];
    const hasMore = after !== undefined && rows.length > 100;
    const selected = rows.slice(0, after === undefined ? 20 : 100);
    return {
      items: selected.map((row) => ({
        ...checkFromRow(row),
        monitorName: row.monitor_name,
        monitorUrl: row.monitor_url,
      })),
      cursor:
        after === undefined
          ? (selected[0]?.id ?? 0)
          : (selected.at(-1)?.id ?? after),
      hasMore,
    };
  }
  list(): Monitor[] {
    return this.db
      .prepare("SELECT * FROM monitors ORDER BY created_at DESC")
      .all()
      .map((row) => {
        const monitor = monitorFromRow(row);
        monitor.running = this.inFlight.has(monitor.id);
        return monitor;
      });
  }
  get(id: string): Monitor {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id = ?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "监控任务不存在。", 404);
    return { ...monitorFromRow(row), running: this.inFlight.has(id) };
  }
  create(input: MonitorInput): Monitor {
    const config = validateInput(input);
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO monitors (id, config_json, enabled, created_at, updated_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, JSON.stringify(config), Number(config.enabled), now, now, now);
    return this.get(id);
  }
  update(id: string, input: Partial<MonitorInput>): Monitor {
    const current = this.get(id),
      patch = validatePatch(input);
    const oldConfig: MonitorInput = {
      name: current.name,
      url: current.url,
      mode: current.mode,
      selector: current.selector,
      ignoreSelectors: current.ignoreSelectors,
      titleSelector: current.titleSelector,
      linkSelector: current.linkSelector,
      intervalMinutes: current.intervalMinutes,
      enabled: current.enabled,
    };
    const config = validateInput({ ...oldConfig, ...patch });
    const ruleSignature = (r: Rule) =>
      JSON.stringify([
        r.url,
        r.mode,
        r.selector,
        r.mode === "TEXT" ? [...(r.ignoreSelectors ?? [])].sort() : [],
        r.mode === "LIST" ? (r.titleSelector ?? "") : "",
        r.mode === "LIST" ? (r.linkSelector ?? "") : "",
      ]);
    const reset = ruleSignature(current) !== ruleSignature(config),
      now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE monitors SET config_json = ?, enabled = ?, revision = revision + ?, updated_at = ?,
        next_run_at = ?, baseline_snapshot_id = ?, failure_count = ?, last_error = ?, last_status = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(config),
          Number(config.enabled),
          Number(reset),
          now,
          reset || (!current.enabled && config.enabled)
            ? now
            : config.intervalMinutes !== current.intervalMinutes
              ? nextCheckAt(now, config.intervalMinutes * 60_000)
              : current.nextRunAt,
          reset ? null : current.baselineSnapshotId,
          reset ? 0 : current.failureCount,
          reset ? null : current.lastError,
          reset ? null : current.lastStatus,
          id,
        );
      if (config.enabled !== current.enabled) {
        this.db
          .prepare(
            `INSERT INTO check_runs (monitor_id,status,duration_ms,checked_at,source,summary)
          VALUES (?,?,0,?,'TASK_CONTROL',?)`,
          )
          .run(
            id,
            config.enabled ? "ENABLED" : "DISABLED",
            now,
            config.enabled
              ? "本任务自动检查已开启。"
              : "本任务自动检查已关闭，仍可手动刷新。",
          );
      }
      if (reset) {
        this.db.prepare("DELETE FROM seen_items WHERE monitor_id = ?").run(id);
        this.db
          .prepare("DELETE FROM monitor_previews WHERE monitor_id = ?")
          .run(id);
        this.db
          .prepare("UPDATE monitors SET last_success_at = NULL WHERE id = ?")
          .run(id);
      }
    })();
    return this.get(id);
  }
  delete(id: string) {
    this.get(id);
    this.db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
  }

  testRule(rule: Rule): Promise<ExtractResult> {
    if (this.stopping)
      return Promise.reject(new AppError("STOPPING", "服务正在退出。", 503));
    if (this.queue.length >= 20)
      return Promise.reject(
        new AppError("BUSY", "检查队列已满，请稍后重试。", 429),
      );
    const promise = this.withSlot(() => this.browser.collect(rule));
    this.previews.add(promise);
    void promise.finally(() => this.previews.delete(promise)).catch(() => {});
    return promise;
  }

  check(
    id: string,
    source: CheckSource = "MANUAL",
  ): Promise<{ status?: RunStatus; discarded?: boolean }> {
    if (this.stopping)
      return Promise.reject(new AppError("STOPPING", "服务正在退出。", 503));
    if (this.inFlight.has(id))
      return Promise.reject(
        new AppError("ALREADY_RUNNING", "该任务已在检查中。", 409),
      );
    if (this.queue.length >= 20)
      return Promise.reject(
        new AppError("BUSY", "检查队列已满，请稍后重试。", 429),
      );
    const monitor = this.get(id);
    const promise = this.withSlot(async () => {
      const host = new URL(monitor.url).host;
      const wait = Math.max(
        0,
        (this.hostStarts.get(host) ?? 0) +
          (this.options.hostDelayMs ?? 2000) -
          Date.now(),
      );
      this.hostStarts.set(host, Date.now() + wait);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const start = Date.now();
      let result: ExtractResult | undefined, failure: AppError | undefined;
      let thumbnail: Uint8Array | undefined;
      try {
        const collected = await this.browser.collect(monitor, {
          thumbnail: true,
        });
        ({ thumbnail, ...result } = collected);
      } catch (error) {
        failure =
          error instanceof AppError
            ? error
            : new AppError(
                "BROWSER_FAILED",
                "浏览器采集失败，请检查浏览器安装和运行环境。",
              );
      }
      const now = Date.now();
      return this.db.transaction(() => {
        const row = this.db
          .prepare("SELECT * FROM monitors WHERE id = ?")
          .get(id);
        if (!row || monitorFromRow(row).revision !== monitor.revision)
          return { discarded: true };
        const current = monitorFromRow(row);
        let status: RunStatus = "FAILED",
          baselineId = current.baselineSnapshotId;
        let detail: ChangeDetail | undefined;
        if (result) {
          const previousRow = baselineId
            ? (this.db
                .prepare("SELECT * FROM snapshots WHERE id = ?")
                .get(baselineId) as any)
            : undefined;
          const previous: ExtractResult | undefined =
            previousRow && JSON.parse(previousRow.content_json);
          if (!previous || previous.hash !== result.hash) {
            baselineId = Number(
              this.db
                .prepare(
                  "INSERT INTO snapshots (monitor_id, content_hash, content_json, created_at) VALUES (?, ?, ?, ?)",
                )
                .run(id, result.hash, JSON.stringify(result), now)
                .lastInsertRowid,
            );
          }
          status = previous ? "UNCHANGED" : "BASELINE";
          if (
            result.mode === "TEXT" &&
            previous?.mode === "TEXT" &&
            previous.hash !== result.hash
          ) {
            detail = {
              mode: "TEXT",
              oldSnapshotId: current.baselineSnapshotId!,
              newSnapshotId: baselineId!,
              before: previous.text,
              after: result.text,
              diff: compareText(previous.text, result.text).diff,
            };
          }
          if (result.mode === "LIST") {
            const seen = new Set(
              (
                this.db
                  .prepare(
                    "SELECT item_key FROM seen_items WHERE monitor_id = ?",
                  )
                  .all(id) as { item_key: string }[]
              ).map((x) => x.item_key),
            );
            const added = unseenItems(result.items, seen);
            const insert = this.db.prepare(
              "INSERT OR IGNORE INTO seen_items (monitor_id, item_key, title, url, first_seen_at) VALUES (?, ?, ?, ?, ?)",
            );
            for (const item of added)
              insert.run(id, item.key, item.title, item.url, now);
            if (previous && added.length)
              detail = { mode: "LIST", items: added };
          }
          if (detail) {
            status = "CHANGED";
            this.db
              .prepare(
                "INSERT INTO change_events (monitor_id, type, detail_json, next_notification_at, created_at) VALUES (?, ?, ?, ?, ?)",
              )
              .run(id, result.mode, JSON.stringify(detail), now, now);
          }
        }
        let summary: string | null = null;
        if (result) {
          summary =
            result.mode === "TEXT"
              ? `匹配 ${result.matchCount} 个区域 · ${Array.from(result.text).length} 字${detail?.mode === "TEXT" ? ` · 新增 ${detail.diff.filter((p) => p.added).reduce((n, p) => n + Array.from(p.value).length, 0)} 字 / 删除 ${detail.diff.filter((p) => p.removed).reduce((n, p) => n + Array.from(p.value).length, 0)} 字` : ""}`
              : `匹配 ${result.matchCount} 个条目 · 本次新增 ${detail?.mode === "LIST" ? detail.items.length : 0} 条`;
          this.db
            .prepare("UPDATE monitors SET last_success_at = ? WHERE id = ?")
            .run(now, id);
          // Keep thumbnails aligned with the latest successful content; never show a stale image as current.
          this.db
            .prepare("DELETE FROM monitor_previews WHERE monitor_id = ?")
            .run(id);
          if (thumbnail)
            this.db
              .prepare(
                "INSERT INTO monitor_previews (monitor_id, image, captured_at) VALUES (?, ?, ?)",
              )
              .run(id, Buffer.from(thumbnail), now);
        }
        const failures = failure ? current.failureCount + 1 : 0;
        const interval = current.intervalMinutes * 60_000;
        const delay = failure
          ? Math.min(24 * 60 * 60_000, interval * 2 ** Math.min(failures, 10))
          : interval;
        this.db
          .prepare(
            `UPDATE monitors SET baseline_snapshot_id = ?, last_checked_at = ?, last_changed_at = ?, last_status = ?,
          last_error = ?, failure_count = ?, next_run_at = ? WHERE id = ?`,
          )
          .run(
            baselineId,
            now,
            detail ? now : current.lastChangedAt,
            status,
            failure?.message ?? null,
            failures,
            nextCheckAt(now, delay),
            id,
          );
        this.db
          .prepare(
            "INSERT INTO check_runs (monitor_id, status, duration_ms, error_code, error_message, checked_at, source, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            status,
            now - start,
            failure?.code ?? null,
            failure?.message ?? null,
            now,
            source,
            summary,
          );
        return { status };
      })();
    });
    this.inFlight.set(id, promise);
    void promise.finally(() => this.inFlight.delete(id)).catch(() => {});
    return promise;
  }

  events(id: string, pageIndex = 1, pageSize = 20): PageResult<ChangeEvent> {
    this.get(id);
    return {
      items: this.db
        .prepare(
          "SELECT * FROM change_events WHERE monitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(id, pageSize, (pageIndex - 1) * pageSize)
        .map(eventFromRow),
      total: (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM change_events WHERE monitor_id = ?",
          )
          .get(id) as { n: number }
      ).n,
      pageIndex,
      pageSize,
    };
  }
  checks(id: string, pageIndex = 1, pageSize = 20): PageResult<CheckRun> {
    this.get(id);
    return {
      items: this.db
        .prepare(
          "SELECT * FROM check_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(id, pageSize, (pageIndex - 1) * pageSize)
        .map(checkFromRow),
      total: (
        this.db
          .prepare("SELECT count(*) AS n FROM check_runs WHERE monitor_id = ?")
          .get(id) as { n: number }
      ).n,
      pageIndex,
      pageSize,
    };
  }
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      if (this.stopping) throw new AppError("STOPPING", "服务正在退出。", 503);
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  async drain() {
    await Promise.allSettled([
      ...this.inFlight.values(),
      ...this.previews,
      ...(this.batch ? [this.batch] : []),
    ]);
  }
  async stop() {
    this.stopping = true;
    await this.drain();
  }
}
