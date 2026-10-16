import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/src/db/database.js";
import { MonitorService } from "../server/src/monitor/monitor-service.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { NotificationWorker } from "../server/src/notification/ntfy.js";
import { startFixture } from "./fixtures.js";

test("deleting a monitor removes notifications not yet sent by the current batch", async () => {
  const fixture = await startFixture(),
    db = openDatabase(":memory:");
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 30,
  });
  const service = new MonitorService(db, browser, { hostDelayMs: 0 });
  try {
    const m = service.create({
      name: "待删除",
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      intervalMinutes: 30,
      enabled: true,
    });
    await service.check(m.id);
    fixture.state.text = "v2";
    await service.check(m.id);
    fixture.state.text = "v3";
    await service.check(m.id);
    fixture.state.notifyDelay = 200;
    const pending = new NotificationWorker(db, {
      target: fixture.url + "/ntfy",
    }).tick();
    while (!fixture.state.deliveries.length)
      await new Promise((resolve) => setTimeout(resolve, 5));
    service.delete(m.id);
    await pending;
    assert.equal(fixture.state.deliveries.length, 1);
  } finally {
    await service.drain();
    await browser.close();
    db.close();
    await fixture.close();
  }
});

test("ntfy payload respects the UTF-8 byte limit for long Chinese diffs", async () => {
  const fixture = await startFixture(),
    db = openDatabase(":memory:");
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 30,
  });
  const service = new MonitorService(db, browser, { hostDelayMs: 0 });
  try {
    const m = service.create({
      name: "长文本",
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      intervalMinutes: 30,
      enabled: true,
    });
    await service.check(m.id);
    fixture.state.text = "中".repeat(2500);
    await service.check(m.id);
    await new NotificationWorker(db, { target: fixture.url + "/ntfy" }).tick();
    assert.ok(Buffer.byteLength(fixture.state.deliveries[0]) <= 4096);
    assert.ok(fixture.state.deliveries[0].includes("完整变化"));
    assert.ok(!fixture.state.deliveries[0].includes("\ufffd"));
    assert.equal(service.events(m.id).items[0].notificationStatus, "SENT");
  } finally {
    await service.drain();
    await browser.close();
    db.close();
    await fixture.close();
  }
});
