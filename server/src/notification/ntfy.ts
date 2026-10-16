import type { Db } from "../db/database.js";
import { eventFromRow } from "../db/database.js";

export interface NotificationOptions {
  target?: string;
  token?: string;
  retryBaseMs?: number;
}
export class NotificationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopping = false;
  constructor(
    private db: Db,
    private options: NotificationOptions = {},
  ) {}
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sendPending().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async sendPending() {
    if (!this.options.target) return;
    const rows = this.db
      .prepare(
        `SELECT e.*, m.config_json FROM change_events e JOIN monitors m ON m.id = e.monitor_id
      WHERE notification_status = 'PENDING' AND next_notification_at <= ? ORDER BY e.id LIMIT 20`,
      )
      .all(Date.now()) as any[];
    for (const row of rows) {
      if (this.stopping) break;
      if (
        !this.db
          .prepare(
            "SELECT id FROM change_events WHERE id = ? AND notification_status = 'PENDING'",
          )
          .get(row.id)
      )
        continue;
      const event = eventFromRow(row),
        monitor = JSON.parse(row.config_json);
      const body =
        event.detail.mode === "LIST"
          ? event.detail.items.map((i) => `${i.title}\n${i.url}`).join("\n\n")
          : event.detail.diff
              .map(
                (part) =>
                  `${part.added ? "+" : part.removed ? "-" : " "}${part.value}`,
              )
              .join("");
      const bytes = Buffer.from(
        `${monitor.name}\n${monitor.url}\n\n${body}`,
        "utf8",
      );
      const payload =
        bytes.length > 3800
          ? new TextDecoder().decode(bytes.subarray(0, 3800), {
              stream: true,
            }) + "\n…（完整变化请在 PageSentinel 查看）"
          : bytes.toString("utf8");
      try {
        const response = await fetch(this.options.target, {
          method: "POST",
          headers: {
            "content-type": "text/plain; charset=utf-8",
            title: "PageSentinel: page changed",
            ...(this.options.token
              ? { Authorization: `Bearer ${this.options.token}` }
              : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.db
          .prepare(
            "UPDATE change_events SET notification_status = 'SENT', notification_attempts = notification_attempts + 1, notification_error = NULL WHERE id = ?",
          )
          .run(event.id);
      } catch {
        const delay = Math.min(
          6 * 60 * 60_000,
          (this.options.retryBaseMs ?? 30_000) *
            2 ** Math.min(event.notificationAttempts, 10),
        );
        this.db
          .prepare(
            "UPDATE change_events SET notification_attempts = notification_attempts + 1, next_notification_at = ?, notification_error = ? WHERE id = ?",
          )
          .run(Date.now() + delay, "ntfy 推送失败，将自动重试。", event.id);
      }
    }
  }
  start() {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
