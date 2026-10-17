import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../server/src/app.js";
import { openDatabase } from "../server/src/db/database.js";
import { authFixture, credentials, unlock } from "./auth-fixtures.js";

test("actual v0.1 schema upgrades without losing business rows; backup restore uses original DB", async () => {
  mkdirSync(resolve(".superpowers/v0.2"), { recursive: true });
  const dir = mkdtempSync(resolve(".superpowers/v0.2/upgrade-")),
    legacyModule = join(dir, "legacy.ts"),
    path = join(dir, "db.sqlite"),
    backup = join(dir, "backup.sqlite");
  writeFileSync(
    legacyModule,
    execFileSync("git", ["show", "HEAD:server/src/db/database.ts"]),
  );
  const { openDatabase: legacyOpen } = await import(
    pathToFileURL(legacyModule).href
  );
  try {
    const legacy = legacyOpen(path);
    const id = "legacy-public",
      config = {
        name: "legacy",
        url: "https://example.com",
        mode: "TEXT",
        selector: "main",
        intervalMinutes: 30,
        enabled: false,
      };
    legacy
      .prepare(
        "INSERT INTO monitors(id,config_json,enabled,created_at,updated_at,next_run_at) VALUES(?,?,0,1,1,1)",
      )
      .run(id, JSON.stringify(config));
    legacy
      .prepare(
        "INSERT INTO snapshots(monitor_id,content_hash,content_json,created_at) VALUES(?,?,?,1)",
      )
      .run(
        id,
        "hash",
        '{"mode":"TEXT","text":"legacy-content","hash":"hash","matchCount":1}',
      );
    legacy
      .prepare("UPDATE monitors SET baseline_snapshot_id=1 WHERE id=?")
      .run(id);
    legacy
      .prepare("INSERT INTO seen_items VALUES(?,?,?,?,1)")
      .run(id, "key", "title", "https://example.com/item");
    legacy
      .prepare(
        "INSERT INTO change_events(monitor_id,type,detail_json,next_notification_at,created_at) VALUES(?,?,?,?,1)",
      )
      .run(id, "LIST", '{"mode":"LIST","items":[]}', 1);
    legacy
      .prepare(
        "INSERT INTO check_runs(monitor_id,status,duration_ms,checked_at) VALUES(?,'BASELINE',1,1)",
      )
      .run(id);
    const tables = [
      "monitors",
      "snapshots",
      "seen_items",
      "change_events",
      "check_runs",
    ];
    const before = Object.fromEntries(
      tables.map((t) => [t, legacy.prepare(`SELECT * FROM ${t}`).all()]),
    );
    await legacy.backup(backup);
    legacy.close();
    const upgraded = openDatabase(path);
    for (const table of tables) {
      const row = upgraded.prepare(`SELECT * FROM ${table}`).all() as any[];
      for (const [key, value] of Object.entries((before as any)[table][0]))
        assert.deepEqual(row[0][key], value, `${table}.${key}`);
    }
    assert.equal(
      (upgraded.prepare("SELECT auth_profile_id FROM monitors").get() as any)
        .auth_profile_id,
      null,
    );
    assert.equal(upgraded.pragma("integrity_check", { simple: true }), "ok");
    upgraded.close();
    copyFileSync(backup, path);
    const restored = legacyOpen(path);
    for (const table of tables)
      assert.deepEqual(
        restored.prepare(`SELECT * FROM ${table}`).all(),
        before[table],
      );
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("restart retains encrypted state and alert retries; wrong key fails closed; revoked/deleted identities never release protection", async () => {
  mkdirSync(resolve(".superpowers/v0.2"), { recursive: true });
  const dir = mkdtempSync(resolve(".superpowers/v0.2/restart-")),
    databasePath = join(dir, "db.sqlite"),
    f = await authFixture(),
    config = credentials();
  const options = {
    databasePath,
    workers: false,
    ...config,
    ntfyTarget: f.url + "/ntfy",
    browserOptions: {
      allowedHosts: ["127.0.0.1"],
      targetTimeoutMs: 100,
      sampleIntervalMs: 20,
    },
  };
  let instance = await createApp(options);
  try {
    const p = await instance.profiles.create(f.profile);
    await instance.profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
    const m = instance.service.create({
      name: "private",
      url: f.url + "/private",
      mode: "TEXT",
      selector: "article",
      enabled: false,
      intervalMinutes: 30,
      authProfileId: p.id,
    });
    await instance.service.check(m.id);
    const baseline = instance.service.get(m.id).baselineSnapshotId;
    f.state.valid = false;
    await instance.service.check(m.id);
    await instance.app.close();
    instance = await createApp(options);
    assert.equal(instance.service.get(m.id).baselineSnapshotId, baseline);
    assert.equal(
      (
        instance.db
          .prepare("SELECT count(*) n FROM auth_alerts WHERE status='PENDING'")
          .get() as any
      ).n,
      1,
    );
    await instance.notifications.tick();
    assert.equal(f.state.deliveries.length, 1);
    await instance.app.close();
    instance = await createApp({
      ...options,
      authMasterKey: credentials().authMasterKey,
    });
    assert.equal(instance.profiles.get(p.id).status, "NEEDS_LOGIN");
    const headers = await unlock(instance.app, config.adminToken);
    assert.equal((await instance.app.inject("/api/monitors")).statusCode, 401);
    assert.equal(
      (await instance.app.inject({ url: "/api/monitors", headers })).statusCode,
      200,
    );
    await instance.app.close();
    instance = await createApp(options);
    f.state.valid = true;
    await instance.profiles.verify(p.id);
    assert.equal(instance.service.get(m.id).authBlockedCode, null);
    instance.profiles.revoke(p.id);
    instance.service.update(m.id, { authProfileId: null });
    instance.profiles.delete(p.id);
    await instance.app.close();
    await assert.rejects(createApp({ databasePath, workers: false }), {
      code: "AUTH_CONFIG",
    });
    instance = await createApp(options);
    assert.equal((await instance.app.inject("/api/updates")).statusCode, 401);
    assert.equal(
      readFileSync(databasePath).includes(Buffer.from("fixture-A")),
      false,
    );
  } finally {
    await instance.app.close().catch(() => {});
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
