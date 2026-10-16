import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/src/app.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { nextCheckAt } from "../server/src/monitor/monitor-service.js";
import { startFixture } from "./fixtures.js";
import { validateInput } from "../server/src/validation.js";

const config = {
  name: "自定义任务",
  url: "https://example.org",
  mode: "TEXT" as const,
  selector: "article",
  intervalMinutes: 1,
  enabled: true,
};
test("custom interval accepts integer 1..1500 minutes and jitter is always +/-5..10 seconds", () => {
  for (const intervalMinutes of [1, 7, 60, 1440, 1500])
    assert.equal(
      validateInput({ ...config, intervalMinutes }).intervalMinutes,
      intervalMinutes,
    );
  for (const intervalMinutes of [0, -1, 1501, 1.5])
    assert.throws(() => validateInput({ ...config, intervalMinutes }));
  const sample = (values: number[]) => () => values.shift()!;
  assert.equal(nextCheckAt(1000, 60000, sample([0, 0])), 56000);
  assert.equal(nextCheckAt(1000, 60000, sample([1, 0])), 66000);
  assert.equal(nextCheckAt(1000, 60000, sample([0, 0.99999])), 51000);
  assert.equal(nextCheckAt(1000, 60000, sample([1, 0.99999])), 71000);
});

test("per-task pause, forced batch including paused tasks, deadline reset, latest content, thumbnail and result feed", async () => {
  const fixture = await startFixture();
  const { app, db, service, scheduler } = await createApp({
    databasePath: ":memory:",
    workers: false,
    collector: new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      sampleIntervalMs: 30,
      targetTimeoutMs: 150,
      navigationTimeoutMs: 1000,
    }),
  });
  try {
    const enabled = service.create({
      ...config,
      url: fixture.url,
      ignoreSelectors: [".stamp"],
    });
    const paused = service.create({
      ...config,
      name: "暂停任务",
      url: fixture.url,
      enabled: false,
      ignoreSelectors: [".stamp"],
    });
    assert.deepEqual(service.current(enabled.id), {
      content: null,
      capturedAt: null,
      thumbnailAt: null,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/monitors/check-all",
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().total, 2);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/monitors/check-all" }))
        .statusCode,
      409,
    );
    await service.drain();
    assert.equal(service.settings().refreshingAll, false);
    for (const m of [enabled, paused]) {
      assert.equal(service.get(m.id).lastStatus, "BASELINE");
      const completed = service.get(m.id);
      assert.ok(
        Math.abs(completed.nextRunAt - completed.lastCheckedAt! - 60000) >=
          5000,
      );
      assert.ok(
        Math.abs(completed.nextRunAt - completed.lastCheckedAt! - 60000) <=
          10000,
      );
      assert.equal(service.checks(m.id).items[0].source, "MANUAL_BATCH");
      assert.ok(service.checks(m.id).items[0].summary?.includes("区域"));
      const current = service.current(m.id);
      assert.equal(current.content?.mode, "TEXT");
      assert.ok(current.thumbnailAt && current.capturedAt);
      const thumbnail = await app.inject(`/api/monitors/${m.id}/thumbnail`);
      assert.equal(thumbnail.statusCode, 200);
      assert.equal(thumbnail.headers["content-type"], "image/jpeg");
      assert.equal(thumbnail.rawPayload.subarray(0, 2).toString("hex"), "ffd8");
    }
    assert.equal(service.get(paused.id).enabled, false);
    const feed = service.updates();
    assert.equal(feed.items.length, 2);
    assert.ok(feed.items[0].monitorName);
    assert.equal(service.updates(feed.cursor).items.length, 0);
    const prior = service.current(enabled.id);
    fixture.state.status = 403;
    await service.check(enabled.id);
    assert.deepEqual(service.current(enabled.id), prior);
    assert.equal(service.updates(feed.cursor).items[0].status, "FAILED");
    fixture.state.status = 200;
    fixture.state.text = "版本 v2";
    await service.check(enabled.id);
    const content = service.current(enabled.id).content;
    assert.equal(content?.mode === "TEXT" ? content.text : "", "版本 v2");
    db.prepare("UPDATE monitors SET next_run_at = 0").run();
    const pausedCount = service.checks(paused.id).total;
    await scheduler.tick();
    await service.drain();
    assert.equal(service.checks(enabled.id).items[0].source, "AUTO");
    assert.equal(service.checks(paused.id).total, pausedCount);
    service.update(enabled.id, { selector: "main" });
    assert.deepEqual(service.current(enabled.id), {
      content: null,
      capturedAt: null,
      thumbnailAt: null,
    });
    assert.equal(
      (await app.inject(`/api/monitors/${enabled.id}/thumbnail`)).statusCode,
      404,
    );
    assert.equal((await app.inject("/api/updates?after=-1")).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { monitoringEnabled: false },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("schema upgrade preserves legacy rows and an obsolete global preference cannot affect tasks", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDatabase } = await import("../server/src/db/database.js");
  const { MonitorService } =
    await import("../server/src/monitor/monitor-service.js");
  const dir = mkdtempSync(join(tmpdir(), "pagesentinel-upgrade-"));
  const path = join(dir, "legacy.sqlite");
  let db = new Database(path);
  const browser = new BrowserCollector();
  try {
    db.exec(`CREATE TABLE monitors (
      id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL, baseline_snapshot_id INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
      last_checked_at INTEGER, last_changed_at INTEGER, last_status TEXT, last_error TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE check_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      status TEXT NOT NULL, duration_ms INTEGER NOT NULL, error_code TEXT, error_message TEXT, checked_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
    const id = "89f696a8-1a3a-4db9-abf5-96c609405d2e";
    db.prepare(
      "INSERT INTO monitors (id,config_json,enabled,created_at,updated_at,next_run_at) VALUES (?,?,1,1,1,1)",
    ).run(id, JSON.stringify(config));
    db.prepare(
      "INSERT INTO check_runs (monitor_id,status,duration_ms,checked_at) VALUES (?,'BASELINE',10,1)",
    ).run(id);
    db.close();
    db = openDatabase(path);
    const service = new MonitorService(db, browser);
    assert.equal(service.list().length, 1);
    assert.equal(service.checks(id).items[0].source, "LEGACY");
    db.exec(
      "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_settings VALUES ('monitoringEnabled','false')",
    );
    db.close();
    db = openDatabase(path);
    const restored = new MonitorService(db, browser);
    assert.deepEqual(restored.settings(), { refreshingAll: false });
    assert.equal(restored.get(id).enabled, true);
    assert.equal(restored.checks(id).total, 1);
    assert.equal(db.pragma("user_version", { simple: true }), 2);
  } finally {
    db.close();
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("force-all waits for a full preview queue without silently skipping monitors", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const collector = new BrowserCollector();
  collector.collect = async () => {
    await gate;
    return {
      mode: "TEXT",
      text: "受控内容",
      hash: "controlled",
      matchCount: 1,
    };
  };
  const { app, service } = await createApp({
    databasePath: ":memory:",
    workers: false,
    collector,
  });
  try {
    const first = service.create(config),
      second = service.create({ ...config, name: "任务2" });
    const previews = Array.from({ length: 22 }, () => service.testRule(config));
    service.checkAll();
    release();
    await Promise.all(previews);
    await service.drain();
    assert.equal(service.checks(first.id).total, 1);
    assert.equal(service.checks(second.id).total, 1);
    assert.equal(service.settings().refreshingAll, false);
  } finally {
    release();
    await app.close();
  }
});

test("parallel-view polling has a read allowance independent from manual actions", async () => {
  const { app } = await createApp({ databasePath: ":memory:", workers: false });
  try {
    for (let i = 0; i < 600; i++)
      assert.equal((await app.inject("/api/health")).statusCode, 200);
    assert.equal((await app.inject("/api/health")).statusCode, 429);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors/check-all",
        })
      ).statusCode,
      202,
    );
  } finally {
    await app.close();
  }
});

test("per-task on/off operations are recorded without changing content results or producing result notifications", async () => {
  const collector = new BrowserCollector();
  collector.collect = async () => ({
    mode: "TEXT",
    text: "有效正文",
    hash: "baseline",
    matchCount: 1,
  });
  const { app, db, service, scheduler } = await createApp({
    databasePath: ":memory:",
    workers: false,
    collector,
  });
  try {
    const m = service.create(config);
    await service.check(m.id);
    const baseline = service.get(m.id);
    service.update(m.id, { enabled: false });
    const off = service.checks(m.id).items[0];
    assert.equal(off.status, "DISABLED");
    assert.equal(off.source, "TASK_CONTROL");
    assert.equal(off.durationMs, 0);
    assert.ok(off.checkedAt >= baseline.lastCheckedAt!);
    assert.ok(off.summary?.includes("手动"));
    service.update(m.id, { enabled: false });
    assert.equal(service.checks(m.id).total, 2);
    db.prepare("UPDATE monitors SET next_run_at=0").run();
    await scheduler.tick();
    await service.drain();
    assert.equal(service.checks(m.id).total, 2);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${m.id}`,
      payload: { enabled: true },
    });
    assert.equal(response.statusCode, 200);
    const on = service.checks(m.id).items[0];
    assert.equal(on.status, "ENABLED");
    assert.equal(on.source, "TASK_CONTROL");
    assert.equal(service.get(m.id).lastStatus, "BASELINE");
    assert.equal(service.get(m.id).lastCheckedAt, baseline.lastCheckedAt);
    assert.equal(
      service.get(m.id).baselineSnapshotId,
      baseline.baselineSnapshotId,
    );
    assert.equal(service.events(m.id).total, 0);
    assert.equal(service.updates().items.length, 1);
    assert.equal(service.updates().items[0].status, "BASELINE");
    db.exec(
      "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_settings VALUES ('monitoringEnabled','false')",
    );
    db.prepare("UPDATE monitors SET next_run_at=0").run();
    await scheduler.tick();
    await service.drain();
    assert.equal(service.checks(m.id).items[0].source, "AUTO");
  } finally {
    await app.close();
  }
});
