import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { createApp } from "../server/src/app.js";
import { authFixture, credentials } from "./auth-fixtures.js";

const waitFor = async (condition: () => boolean) => {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
test("authenticated TEXT/LIST and previews isolate accounts, rotate cookies on extraction failure, and reset only on account switch", async () => {
  const f = await authFixture(),
    browser = new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      sampleIntervalMs: 20,
      targetTimeoutMs: 100,
    });
  const { app, service, profiles, db } = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...credentials(),
    collector: browser,
  });
  try {
    const a = await profiles.create(f.profile),
      b = await profiles.create({ ...f.profile, name: "B" });
    await profiles.importState(a.id, f.cookie(), "SAME_ACCOUNT");
    await profiles.importState(b.id, f.cookie("fixture-B"), "SAME_ACCOUNT");
    const input = {
      name: "private",
      url: f.url + "/private",
      mode: "TEXT" as const,
      selector: "article",
      enabled: false,
      intervalMinutes: 1,
    };
    const ma = service.create({ ...input, authProfileId: a.id }),
      mb = service.create({ ...input, authProfileId: b.id });
    await Promise.all([service.check(ma.id), service.check(mb.id)]);
    assert.match(JSON.stringify(service.current(ma.id)), /account-A/);
    assert.match(JSON.stringify(service.current(mb.id)), /account-B/);
    const baseline = service.get(ma.id).baselineSnapshotId;
    await profiles.importState(a.id, f.cookie(), "SAME_ACCOUNT");
    assert.equal(service.get(ma.id).baselineSnapshotId, baseline);
    const before = service.checks(ma.id).total;
    await service.testRule({ ...input, authProfileId: a.id });
    assert.equal(service.checks(ma.id).total, before);
    f.state.rotate = true;
    await assert.rejects(
      service.testRule({ ...input, selector: ".missing", authProfileId: a.id }),
      { code: "TARGET_TIMEOUT" },
    );
    assert.equal(profiles.loadState(a.id).cookies[0].value, "rotated");
    assert.equal(service.get(ma.id).baselineSnapshotId, baseline);
    await profiles.importState(a.id, f.cookie("fixture-B"), "SWITCH_ACCOUNT");
    assert.equal(service.get(ma.id).baselineSnapshotId, null);
    assert.equal(service.current(ma.id).thumbnailAt, null);
    assert.equal((await service.check(ma.id)).status, "BASELINE");
    service.update(ma.id, { authProfileId: null });
    assert.equal(service.get(ma.id).baselineSnapshotId, null);
    assert.equal(
      service.checks(ma.id).items.some((run) => run.status === "AUTH_UPDATED"),
      true,
    );
    const list = service.create({
      ...input,
      mode: "LIST",
      selector: "li",
      authProfileId: b.id,
    });
    await service.check(list.id);
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM seen_items WHERE monitor_id=?")
          .get(list.id) as any
      ).n,
      1,
    );
    await assert.rejects(
      Promise.resolve().then(() => profiles.delete(b.id)),
      { code: "AUTH_IN_USE" },
    );
    await profiles.importState(b.id, f.cookie(), "SWITCH_ACCOUNT");
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM seen_items WHERE monitor_id=?")
          .get(list.id) as any
      ).n,
      0,
    );
    assert.equal(browser.activeContexts, 0);
  } finally {
    await app.close();
    await f.close();
  }
});
test("same identity queues before global slots; revoke during IO discards both content and rotated state", async () => {
  const f = await authFixture(),
    browser = new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      sampleIntervalMs: 30,
      targetTimeoutMs: 100,
    });
  const { app, service, profiles, db } = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...credentials(),
    collector: browser,
    concurrency: 2,
  });
  try {
    const p = await profiles.create(f.profile);
    await profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
    const input = {
      name: "private",
      url: f.url + "/private",
      mode: "TEXT" as const,
      selector: "article",
      enabled: true,
      intervalMinutes: 1,
      authProfileId: p.id,
    };
    const tasks = [service.create(input), service.create(input)];
    f.state.delay = 350;
    const first = service.check(tasks[0].id),
      second = service.check(tasks[1].id);
    await waitFor(() => browser.activeContexts === 1);
    assert.equal(service.availableSlots, 1);
    const publicPreview = service.testRule({
      url: f.url + "/login",
      mode: "TEXT",
      selector: "button",
    });
    await waitFor(() => browser.activeContexts === 2);
    await Promise.all([first, second, publicPreview]);
    const baseline = service.get(tasks[0].id).baselineSnapshotId;
    const version = profiles.get(p.id).stateVersion;
    const pending = service.check(tasks[0].id);
    await waitFor(() => browser.activeContexts === 1);
    profiles.revoke(p.id);
    assert.equal((await pending).discarded, true);
    assert.equal(service.get(tasks[0].id).baselineSnapshotId, baseline);
    assert.equal(profiles.get(p.id).stateVersion, version);
    assert.equal(
      (
        db
          .prepare("SELECT ciphertext FROM auth_profiles WHERE id=?")
          .get(p.id) as any
      ).ciphertext,
      null,
    );
    assert.equal(browser.activeContexts, 0);
  } finally {
    await app.close();
    await f.close();
  }
});
