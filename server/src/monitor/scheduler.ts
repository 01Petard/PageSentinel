import type { Db } from "../db/database.js";
import type { MonitorService } from "./monitor-service.js";

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private db: Db,
    private service: MonitorService,
    private intervalMs = 1000,
  ) {}
  async tick() {
    if (this.service.settings().refreshingAll) return;
    const slots = this.service.availableSlots;
    if (!slots) return;
    const due = this.db
      .prepare(
        "SELECT id FROM monitors WHERE enabled = 1 AND auth_blocked_code IS NULL AND next_run_at <= ? ORDER BY next_run_at",
      )
      .all(Date.now()) as { id: string }[];
    let started = 0;
    for (const { id } of due) {
      if (this.service.get(id).running) continue;
      void this.service.check(id, "AUTO").catch(() => {});
      if (++started >= slots) break;
    }
  }
  start() {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
}
