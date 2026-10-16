import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/src/db/database.js";
import { MonitorService } from "../server/src/monitor/monitor-service.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { NotificationWorker } from "../server/src/notification/ntfy.js";
import { Scheduler } from "../server/src/monitor/scheduler.js";
import { startFixture } from "./fixtures.js";

test("partial edits preserve omitted interval and paused state", async () => {
  const db = openDatabase(":memory:");
  const browser = new BrowserCollector();
  const service = new MonitorService(db, browser);
  try {
    const m = service.create({
      name: "原名",
      url: "https://example.org",
      mode: "TEXT",
      selector: "main",
      intervalMinutes: 180,
      enabled: false,
    });
    const renamed = service.update(m.id, { name: "新名" });
    assert.equal(renamed.intervalMinutes, 180);
    assert.equal(renamed.enabled, false);
    const changedInterval = service.update(m.id, { intervalMinutes: 60 });
    assert.equal(changedInterval.enabled, false);
    const enabled = service.update(m.id, { enabled: true });
    assert.equal(enabled.intervalMinutes, 60);
    assert.equal(enabled.name, "新名");
  } finally {
    await service.stop();
    await browser.close();
    db.close();
  }
});

test("six acceptance groups: baseline, noise, failures, edits, history, restart and notification retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pagesentinel-"));
  const fixture = await startFixture();
  let db = openDatabase(join(dir, "test.sqlite"));
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 40,
    targetTimeoutMs: 180,
    stabilityTimeoutMs: 250,
    navigationTimeoutMs: 1000,
  });
  let service = new MonitorService(db, browser, { hostDelayMs: 0 });
  try {
    const text = service.create({
      name: "版本",
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      ignoreSelectors: [".stamp"],
      intervalMinutes: 30,
      enabled: true,
    });
    assert.equal((await service.check(text.id)).status, "BASELINE");
    assert.equal(service.events(text.id).total, 0);
    const baseline = service.get(text.id).baselineSnapshotId;
    fixture.state.text = "版本 v2";
    await service.testRule(text);
    assert.equal(service.get(text.id).baselineSnapshotId, baseline);
    assert.equal(service.checks(text.id).total, 1);
    assert.equal((await service.check(text.id)).status, "CHANGED");
    assert.equal(service.events(text.id).total, 1);
    fixture.state.text = "  版本   v2  ";
    fixture.state.stamp = "明天";
    assert.equal((await service.check(text.id)).status, "UNCHANGED");
    const successfulBaseline = service.get(text.id).baselineSnapshotId;
    for (const status of [403, 429]) {
      fixture.state.status = status;
      assert.equal((await service.check(text.id)).status, "FAILED");
      assert.equal(service.get(text.id).baselineSnapshotId, successfulBaseline);
      assert.ok(service.get(text.id).nextRunAt > Date.now());
    }
    fixture.state.status = 200;
    service.update(text.id, { name: "新名字", intervalMinutes: 60 });
    assert.equal(service.get(text.id).baselineSnapshotId, successfulBaseline);
    assert.equal((await service.check(text.id)).status, "UNCHANGED");
    service.update(text.id, { selector: "main" });
    assert.equal(service.get(text.id).baselineSnapshotId, null);
    assert.equal(service.get(text.id).lastStatus, null);
    assert.equal((await service.check(text.id)).status, "BASELINE");

    const list = service.create({
      name: "列表",
      url: fixture.url + "/list",
      mode: "LIST",
      selector: "li",
      titleSelector: "a",
      linkSelector: "a",
      intervalMinutes: 15,
      enabled: true,
    });
    assert.equal((await service.check(list.id)).status, "BASELINE");
    fixture.state.items = ["D", "A", "B"];
    assert.equal((await service.check(list.id)).status, "CHANGED");
    fixture.state.items = ["B", "D", "A"];
    assert.equal((await service.check(list.id)).status, "UNCHANGED");
    fixture.state.items = [];
    assert.equal((await service.check(list.id)).status, "FAILED");
    fixture.state.items = ["C", "B", "D"];
    assert.equal((await service.check(list.id)).status, "UNCHANGED");
    assert.equal(service.events(list.id).total, 1);

    const busy = service.check(list.id);
    await assert.rejects(service.check(list.id), { code: "ALREADY_RUNNING" });
    await busy;
    service.update(list.id, { enabled: false });
    db.prepare("UPDATE monitors SET next_run_at = 0").run();
    const scheduler = new Scheduler(db, service);
    const count = service.checks(list.id).total;
    await scheduler.tick();
    await service.drain();
    assert.equal(service.checks(list.id).total, count);

    const worker = new NotificationWorker(db, {
      target: fixture.url + "/ntfy",
      retryBaseMs: 1,
    });
    fixture.state.notifyStatus = 500;
    await worker.tick();
    assert.equal(
      service.events(list.id).items[0].notificationStatus,
      "PENDING",
    );
    assert.equal(service.events(list.id).items[0].notificationAttempts, 1);
    const eventsBefore = service.events(text.id).total;
    await service.drain();
    db.close();
    db = openDatabase(join(dir, "test.sqlite"));
    service = new MonitorService(db, browser, { hostDelayMs: 0 });
    assert.equal(service.events(text.id).total, eventsBefore);
    assert.equal((await service.check(list.id)).status, "UNCHANGED");
    fixture.state.notifyStatus = 200;
    db.prepare("UPDATE change_events SET next_notification_at = 0").run();
    await new NotificationWorker(db, { target: fixture.url + "/ntfy" }).tick();
    assert.equal(service.events(list.id).items[0].notificationStatus, "SENT");
    assert.ok(fixture.state.deliveries.some((body) => body.includes("条目 D")));
    service.delete(list.id);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM seen_items WHERE monitor_id = ?")
        .get(list.id).n,
      0,
    );
  } finally {
    await service.drain();
    await browser.close();
    db.close();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rule edit during browser IO cannot commit the old result", async () => {
  const fixture = await startFixture();
  const db = openDatabase(":memory:");
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 100,
  });
  const service = new MonitorService(db, browser, { hostDelayMs: 0 });
  try {
    const m = service.create({
      name: "SPA",
      url: fixture.url + "/spa",
      mode: "TEXT",
      selector: "article",
      intervalMinutes: 30,
      enabled: true,
    });
    const check = service.check(m.id);
    service.update(m.id, { selector: "main" });
    assert.equal((await check).discarded, true);
    assert.equal(service.get(m.id).baselineSnapshotId, null);
    assert.equal(service.checks(m.id).total, 0);
  } finally {
    await service.drain();
    await browser.close();
    db.close();
    await fixture.close();
  }
});
