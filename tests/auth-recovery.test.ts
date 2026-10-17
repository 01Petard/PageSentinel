import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/src/app.js";
import { authFixture, credentials } from "./auth-fixtures.js";

test("HTTP 200 login and redirect preserve baselines; path-specific 403/marker failures do not invalidate the account", async () => {
  const f = await authFixture(),
    { app, service, profiles, db, notifications, scheduler } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      ntfyTarget: f.url + "/ntfy",
      browserOptions: {
        allowedHosts: ["127.0.0.1"],
        sampleIntervalMs: 20,
        targetTimeoutMs: 100,
      },
    });
  try {
    const p = await profiles.create(f.profile);
    await profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
    const input = {
      name: "受控私密任务",
      url: f.url + "/private",
      mode: "TEXT" as const,
      selector: "article",
      intervalMinutes: 1,
      enabled: true,
      authProfileId: p.id,
    };
    const m = service.create(input),
      other = service.create({
        ...input,
        name: "同账号另一任务",
        enabled: false,
      });
    await service.check(m.id);
    const baseline = service.get(m.id).baselineSnapshotId,
      image = service.current(m.id).thumbnailAt;
    f.state.valid = false;
    assert.equal((await service.check(m.id)).status, "AUTH_UNVERIFIED");
    assert.equal(service.get(m.id).baselineSnapshotId, baseline);
    assert.equal(service.current(m.id).thumbnailAt, image);
    assert.equal(service.get(m.id).lastStatus, "BASELINE");
    assert.equal(service.get(m.id).failureCount, 0);
    assert.equal(profiles.get(p.id).status, "READY");
    assert.equal(service.get(other.id).authBlockedCode, null);
    const count = service.checks(m.id).total;
    await service.check(m.id);
    await scheduler.tick();
    assert.equal(service.checks(m.id).total, count);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM auth_alerts").get() as any).n,
      1,
    );
    f.state.notifyStatus = 503;
    await notifications.tick();
    assert.equal(
      (db.prepare("SELECT attempts FROM auth_alerts").get() as any).attempts,
      1,
    );
    f.state.valid = true;
    await profiles.verify(p.id);
    assert.equal(service.get(m.id).authBlockedCode, null);
    assert.equal(service.get(other.id).enabled, false);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM auth_alerts").get() as any).n,
      0,
    );
    assert.equal((await service.check(m.id)).status, "UNCHANGED");
    const denied = service.create({ ...input, url: f.url + "/denied" });
    assert.equal((await service.check(denied.id)).status, "FAILED");
    assert.equal(service.checks(denied.id).items[0].errorCode, "ACCESS_DENIED");
    assert.equal(profiles.get(p.id).status, "READY");
    const redirect = service.create({ ...input, url: f.url + "/redirect" });
    assert.equal((await service.check(redirect.id)).status, "AUTH_REQUIRED");
    assert.equal(profiles.get(p.id).status, "READY");
    const css = service.create({ ...input, authSuccessSelector: ".missing" });
    assert.equal((await service.check(css.id)).status, "AUTH_UNVERIFIED");
    await profiles.verify(p.id);
    assert.equal(service.get(css.id).authBlockedCode, "AUTH_UNVERIFIED");
    assert.equal(service.get(m.id).authBlockedCode, null);
  } finally {
    await app.close();
    await f.close();
  }
});
test("confirmed 401 blocks the identity once; same-account recovery retains paused state and baseline, alerts and notifications redact private content", async () => {
  const f = await authFixture(),
    { app, service, profiles, notifications, db } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      ntfyTarget: f.url + "/ntfy",
      browserOptions: {
        allowedHosts: ["127.0.0.1"],
        sampleIntervalMs: 20,
        targetTimeoutMs: 100,
      },
    });
  try {
    const p = await profiles.create(f.profile);
    await profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
    const input = {
      name: "private-task",
      url: f.url + "/private",
      mode: "TEXT" as const,
      selector: "article",
      intervalMinutes: 1,
      enabled: false,
      authProfileId: p.id,
    };
    const m = service.create(input),
      second = service.create({ ...input, name: "paused" });
    await service.check(m.id);
    const baseline = service.get(m.id).baselineSnapshotId;
    f.state.status = 401;
    assert.equal((await service.check(m.id)).status, "AUTH_REQUIRED");
    assert.equal(profiles.get(p.id).status, "NEEDS_LOGIN");
    assert.equal(service.get(second.id).authBlockedCode, "AUTH_REQUIRED");
    assert.equal(service.get(m.id).enabled, false);
    assert.equal(service.checkAll().blocked.length, 2);
    await service.drain();
    await notifications.tick();
    assert.equal(f.state.deliveries.length, 2);
    assert.ok(
      f.state.deliveries.every(
        (d) =>
          !d.includes(f.url) &&
          !d.includes(f.state.text) &&
          !d.includes("fixture-A"),
      ),
    );
    f.state.status = 200;
    await profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
    assert.equal(service.get(m.id).baselineSnapshotId, baseline);
    assert.equal(service.get(m.id).enabled, false);
    f.state.text = "private-changed-secret";
    assert.equal((await service.check(m.id)).status, "CHANGED");
    const updates = JSON.stringify(service.updates());
    assert.ok(!updates.includes(f.url));
    assert.ok(!updates.includes(f.state.text));
    service.update(m.id, { authProfileId: null });
    await notifications.tick();
    assert.ok(!f.state.deliveries.at(-1)!.includes(f.url));
    assert.ok(!f.state.deliveries.at(-1)!.includes(f.state.text));
    profiles.revoke(p.id);
    assert.equal(
      (
        db
          .prepare("SELECT count(*) n FROM auth_alerts WHERE status='PENDING'")
          .get() as any
      ).n,
      0,
    );
    assert.equal(
      service.updates().items.some((r) => r.status === "AUTH_REVOKED"),
      false,
    );
  } finally {
    await app.close();
    await f.close();
  }
});
