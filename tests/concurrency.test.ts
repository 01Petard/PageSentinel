import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/src/db/database.js";
import { MonitorService } from "../server/src/monitor/monitor-service.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { startFixture } from "./fixtures.js";

test("manual checks and previews share a global browser concurrency limit", async () => {
  const fixture = await startFixture(),
    db = openDatabase(":memory:");
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 100,
  });
  const service = new MonitorService(db, browser, {
    concurrency: 2,
    hostDelayMs: 0,
  });
  const input = {
    name: "SPA",
    url: fixture.url + "/spa",
    mode: "TEXT" as const,
    selector: "article",
    intervalMinutes: 30,
    enabled: true,
  };
  const monitors = [1, 2, 3].map((i) =>
    service.create({ ...input, name: String(i) }),
  );
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, browser.activeContexts);
  }, 10);
  try {
    await Promise.all([
      ...monitors.map((m) => service.check(m.id)),
      service.testRule(input),
    ]);
    assert.equal(peak, 2);
    assert.equal(browser.activeContexts, 0);
    assert.ok(monitors.every((m) => service.checks(m.id).total === 1));
    await service.stop();
    await assert.rejects(service.check(monitors[0].id), { code: "STOPPING" });
  } finally {
    clearInterval(timer);
    await service.drain();
    await browser.close();
    db.close();
    await fixture.close();
  }
});
