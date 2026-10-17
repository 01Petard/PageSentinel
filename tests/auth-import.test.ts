import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApp } from "../server/src/app.js";
import { normalizeAuthState } from "../server/src/auth/state-parser.js";
import { authFixture, credentials, unlock } from "./auth-fixtures.js";

test("real Chromium imports HttpOnly JSON and raw header; failures retain ciphertext and revision; metadata never leaks state", async () => {
  const f = await authFixture(),
    config = credentials();
  const { app, profiles, db } = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...config,
    browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 200 },
  });
  try {
    const headers = await unlock(app, config.adminToken),
      p = await profiles.create(f.profile);
    assert.equal(p.status, "EMPTY");
    const imported = await app.inject({
      method: "POST",
      url: `/api/auth-profiles/${p.id}/import`,
      headers,
      payload: { input: f.cookie(), accountAction: "SAME_ACCOUNT" },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().status, "READY");
    assert.ok(!imported.body.includes("fixture-A"));
    assert.equal(profiles.loadState(p.id).cookies[0].httpOnly, true);
    const before = db
      .prepare("SELECT * FROM auth_profiles WHERE id=?")
      .get(p.id);
    for (const input of [
      "",
      "{",
      "# Netscape HTTP Cookie File",
      [{ ...f.cookie()[0], expires: Date.now() }],
      [{ ...f.cookie()[0], domain: ".com" }],
      Array(501).fill(f.cookie()[0]),
      { cookies: [], origins: [], credentials: [] },
      {
        cookies: [],
        origins: [{ origin: "https://other.example.com", localStorage: [] }],
      },
      "session=wrong-fixture",
    ]) {
      const r = await app.inject({
        method: "POST",
        url: `/api/auth-profiles/${p.id}/import`,
        headers,
        payload: { input, accountAction: "SAME_ACCOUNT" },
      });
      assert.ok(r.statusCode >= 400, String(r.statusCode));
      assert.ok(!r.body.includes("wrong-fixture"));
      assert.deepEqual(
        db.prepare("SELECT * FROM auth_profiles WHERE id=?").get(p.id),
        before,
      );
    }
    await profiles.importState(
      p.id,
      "Cookie: session=fixture-B",
      "SWITCH_ACCOUNT",
    );
    assert.equal(profiles.loadState(p.id).cookies[0].domain, "127.0.0.1");
    const revision = profiles.get(p.id).revision;
    await profiles.update(p.id, { name: "改名" });
    assert.equal(profiles.get(p.id).revision, revision);
    await assert.rejects(
      profiles.update(p.id, { successSelector: ".missing" }),
      { code: "AUTH_UNVERIFIED" },
    );
    assert.equal(profiles.get(p.id).successSelector, "#member");
    await profiles.update(p.id, { successSelector: "b#member" });
    assert.equal(profiles.get(p.id).revision, revision + 1);
    assert.equal(profiles.loadState(p.id).cookies[0].value, "fixture-B");
  } finally {
    await app.close();
    await f.close();
  }
});

test("real Chromium restores localStorage and installed Playwright IndexedDB state", async () => {
  const f = await authFixture(),
    { app, profiles } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 1000 },
    });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(f.url + "/login");
    await page.evaluate(async () => {
      localStorage.setItem("session", "fixture-LS");
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("auth", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("tokens");
        r.onerror = () => reject(new Error("fixture DB failed"));
        r.onsuccess = () => {
          const tx = r.result.transaction("tokens", "readwrite");
          tx.objectStore("tokens").put("fixture-IDB", "session");
          tx.oncomplete = () => {
            r.result.close();
            resolve();
          };
        };
      });
    });
    const state = await context.storageState({ indexedDB: true });
    for (const path of ["/ls", "/idb"]) {
      const p = await profiles.create({
        ...f.profile,
        verificationUrl: f.url + path,
      });
      assert.equal(
        (await profiles.importState(p.id, state, "SAME_ACCOUNT")).status,
        "READY",
      );
    }
    await context.close();
  } finally {
    await browser.close();
    await app.close();
    await f.close();
  }
});
test("state validation rejects private/shared suffixes, unknown fields, oversized input and ambiguous headers", () => {
  const p = {
    allowedHosts: ["tenant.github.io", "example.com"],
    verificationUrl: "https://example.com/private",
  };
  for (const domain of [".github.io", ".co.uk", ".com", "other.example.com"])
    assert.throws(
      () => normalizeAuthState([{ name: "x", value: "redacted", domain }], p),
      { code: "AUTH_DOMAIN" },
    );
  assert.throws(
    () => normalizeAuthState("x=" + "x".repeat(2 * 1024 * 1024), p),
    { code: "AUTH_STATE_LIMIT" },
  );
  assert.throws(() => normalizeAuthState("x=y\nAuthorization: redacted", p), {
    code: "INVALID_AUTH_STATE",
  });
});

test("state routes alone accept more than 64 KiB and reject more than 2 MiB; metadata limits hosts to twenty", async () => {
  const f = await authFixture(),
    config = credentials();
  const { app, profiles } = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...config,
    browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
  });
  try {
    const headers = await unlock(app, config.adminToken),
      p = await profiles.create(f.profile);
    const input = {
      cookies: f.cookie(),
      origins: [
        {
          origin: f.url,
          localStorage: [
            { name: "large-fixture", value: "x".repeat(80 * 1024) },
          ],
        },
      ],
    };
    const imported = await app.inject({
      method: "POST",
      url: `/api/auth-profiles/${p.id}/import`,
      headers,
      payload: { input, accountAction: "SAME_ACCOUNT" },
    });
    assert.equal(imported.statusCode, 200);
    const oversized = await app.inject({
      method: "POST",
      url: `/api/auth-profiles/${p.id}/import`,
      headers,
      payload: {
        input: "x".repeat(2 * 1024 * 1024),
        accountAction: "SAME_ACCOUNT",
      },
    });
    assert.equal(oversized.statusCode, 413);
    const ordinary = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers,
      payload: { name: "x".repeat(80 * 1024) },
    });
    assert.equal(ordinary.statusCode, 413);
    await assert.rejects(
      profiles.create({
        ...f.profile,
        allowedHosts: Array.from(
          { length: 21 },
          (_, i) => `host${i}.example.com`,
        ),
      }),
      { code: "INVALID_AUTH_PROFILE" },
    );
  } finally {
    await app.close();
    await f.close();
  }
});
