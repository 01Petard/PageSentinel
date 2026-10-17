import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/src/app.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { normalizeAuthState } from "../server/src/auth/state-parser.js";
import { authFixture, credentials } from "./auth-fixtures.js";

async function raceFixture() {
  const f = await authFixture(),
    browser = new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      targetTimeoutMs: 100,
      sampleIntervalMs: 20,
    });
  const runtime = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...credentials(),
    collector: browser,
  });
  const p = await runtime.profiles.create(f.profile);
  await runtime.profiles.importState(p.id, f.cookie(), "SAME_ACCOUNT");
  let start!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      start = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  // Deterministic browser-IO boundary; encryption, locks, monitor persistence and
  // queued verification use real services (verification still uses Chromium).
  browser.collect = async (_rule, options = {}) => {
    start();
    await gate;
    options.authentication?.onState?.(
      normalizeAuthState(
        { cookies: f.cookie("rotated"), origins: [] },
        f.profile,
      ),
    );
    return {
      mode: "TEXT",
      text: "account content",
      hash: "fixture-content",
      matchCount: 1,
    };
  };
  const input = {
    name: "race",
    url: f.url + "/private",
    mode: "TEXT" as const,
    selector: "article",
    intervalMinutes: 30,
    enabled: false,
    authProfileId: p.id,
  };
  return {
    f,
    browser,
    ...runtime,
    p,
    input,
    started,
    release,
    close: async () => {
      release();
      await runtime.app.close();
      await f.close();
    },
  };
}
test("editing/deleting an in-flight monitor discards both content and credential rotation", async () => {
  for (const action of ["edit", "delete"] as const) {
    const r = await raceFixture();
    try {
      const m = r.service.create(r.input),
        version = r.profiles.get(r.p.id).stateVersion,
        pending = r.service.check(m.id);
      await r.started;
      if (action === "edit") r.service.update(m.id, { selector: "main" });
      else r.service.delete(m.id);
      r.release();
      assert.equal((await pending).discarded, true);
      assert.equal(r.profiles.get(r.p.id).stateVersion, version);
    } finally {
      await r.close();
    }
  }
});
test("queued profile verification and rule edits read the latest rotation inside the identity lock", async () => {
  for (const action of ["verify", "rules"] as const) {
    const r = await raceFixture();
    try {
      const m = r.service.create(r.input),
        pending = r.service.check(m.id);
      await r.started;
      const queued =
        action === "verify"
          ? r.profiles.verify(r.p.id)
          : r.profiles.update(r.p.id, { successSelector: "b#member" });
      r.release();
      await pending;
      await queued;
      assert.ok(
        r.profiles.loadState(r.p.id).cookies[0].value === "rotated",
        "queued verification must retain the latest valid session",
      );
    } finally {
      await r.close();
    }
  }
});
test("failure of an old queued identity cannot block a task rebound to a ready identity", async () => {
  const r = await raceFixture();
  try {
    const b = await r.profiles.create(r.f.profile);
    await r.profiles.importState(b.id, r.f.cookie("fixture-B"), "SAME_ACCOUNT");
    const first = r.service.create(r.input),
      queuedMonitor = r.service.create(r.input);
    const pending = r.service.check(first.id);
    await r.started;
    const queued = r.service.check(queuedMonitor.id);
    r.service.update(queuedMonitor.id, { authProfileId: b.id });
    r.profiles.revoke(r.p.id);
    r.release();
    await pending;
    assert.equal((await queued).discarded, true);
    assert.equal(r.service.get(queuedMonitor.id).authBlockedCode, null);
    assert.equal(r.profiles.get(b.id).status, "READY");
  } finally {
    await r.close();
  }
});
test("a page that becomes a login view during extraction cannot commit content or state", async () => {
  const { startFixture } = await import("./fixtures.js");
  const f = await startFixture(),
    browser = new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      sampleIntervalMs: 250,
      targetTimeoutMs: 100,
      stabilityTimeoutMs: 1500,
    });
  f.state.html =
    '<b id="member">member</b><article>account content</article><script>setTimeout(()=>{document.body.innerHTML="<article>Please log in</article>";history.replaceState({},"","/login")},150)</script>';
  let writes = 0;
  try {
    await assert.rejects(
      browser.collect(
        { url: f.url + "/custom", mode: "TEXT", selector: "article" },
        {
          authentication: {
            profile: {
              name: "fixture",
              loginUrl: f.url + "/login",
              verificationUrl: f.url + "/custom",
              allowedHosts: ["127.0.0.1"],
              successSelector: "#member",
              loginUrlPrefix: f.url + "/login",
            },
            state: {
              cookies: [
                {
                  name: "marker",
                  value: "test-marker",
                  domain: "127.0.0.1",
                  path: "/",
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: "Lax",
                },
              ],
              origins: [],
            },
            onState: () => {
              writes++;
            },
          },
        },
      ),
      { code: "AUTH_REQUIRED" },
    );
    assert.equal(writes, 0);
    assert.equal(browser.activeContexts, 0);
  } finally {
    await browser.close();
    await f.close();
  }
});
