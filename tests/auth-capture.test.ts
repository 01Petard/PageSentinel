import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { createApp } from "../server/src/app.js";
import { LoginCaptureService } from "../server/src/auth/login-capture.js";
import { runLoginHelper, helperServer } from "../scripts/auth-login.js";
import { assertPublicUrl } from "../server/src/monitor/network.js";
import { authFixture, credentials, unlock } from "./auth-fixtures.js";

test("capture pairing is single use and scoped; save requires confirmation and deployment verification", async () => {
  const f = await authFixture(),
    config = credentials(),
    { app, profiles, captures } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...config,
      browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
    });
  try {
    const headers = await unlock(app, config.adminToken),
      p = await profiles.create(f.profile),
      p2 = await profiles.create(f.profile);
    const c = captures.create(p.id, "SAME_ACCOUNT"),
      pair = captures.pair(c.pairingCode);
    assert.throws(() => captures.pair(c.pairingCode), {
      code: "PAIRING_REJECTED",
    });
    assert.equal(JSON.stringify(pair).includes("ciphertext"), false);
    const second = captures.create(p2.id, "SAME_ACCOUNT");
    assert.throws(() => captures.create(p.id, "SAME_ACCOUNT"), {
      code: "CAPTURE_LIMIT",
    });
    assert.throws(() => captures.poll(second.id, pair.helperToken), {
      code: "HELPER_UNAUTHORIZED",
    });
    assert.equal(profiles.get(p.id).status, "EMPTY");
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(f.url + "/login");
      await Promise.all([
        page.waitForURL(f.url + "/private"),
        page.getByRole("button", { name: "完成受控登录" }).click(),
      ]);
      const state = await context.storageState({ indexedDB: true });
      assert.equal(profiles.get(p.id).status, "EMPTY");
      const saved = await app.inject({
        method: "POST",
        url: `/api/auth-captures/${c.id}/save`,
        headers,
      });
      assert.equal(saved.statusCode, 200);
      const response = await app.inject({
        method: "POST",
        url: `/api/auth-captures/${c.id}/helper`,
        headers: { authorization: `Bearer ${pair.helperToken}` },
        payload: state,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(captures.get(c.id).status, "COMPLETED");
      assert.equal(profiles.get(p.id).source, "CAPTURE");
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/auth-captures/${c.id}/helper`,
            headers: { authorization: `Bearer ${pair.helperToken}` },
            payload: state,
          })
        ).statusCode,
        401,
      );
    } finally {
      await browser.close();
    }
    captures.cancel(second.id);
    const premature = captures.create(p2.id, "SAME_ACCOUNT"),
      prematurePair = captures.pair(premature.pairingCode);
    assert.throws(
      () =>
        captures.submit(premature.id, prematurePair.helperToken, {
          cookies: f.cookie(),
          origins: [],
        }),
      { code: "SAVE_NOT_REQUESTED" },
    );
    const localOnly = captures.create(p.id, "SAME_ACCOUNT"),
      localPair = captures.pair(localOnly.pairingCode),
      revision = profiles.get(p.id).revision;
    captures.save(localOnly.id);
    f.state.valid = false;
    await assert.rejects(
      captures.submit(localOnly.id, localPair.helperToken, {
        cookies: f.cookie(),
        origins: [],
      }),
    );
    assert.equal(profiles.get(p.id).revision, revision);
    assert.equal(captures.get(localOnly.id).status, "FAILED");
  } finally {
    await app.close();
    await f.close();
  }
});
test("capture TTL, heartbeat, revision and cancel guards prevent stale credential commits", async () => {
  const f = await authFixture(),
    { app, profiles } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
    });
  let now = Date.now();
  const captures = new LoginCaptureService(profiles, () => now);
  try {
    const p = await profiles.create(f.profile);
    const expired = captures.create(p.id, "SAME_ACCOUNT");
    now += 600_001;
    assert.equal(captures.get(expired.id).status, "EXPIRED");
    const disconnected = captures.create(p.id, "SAME_ACCOUNT");
    captures.pair(disconnected.pairingCode);
    now += 30_000;
    assert.equal(
      captures.get(disconnected.id).errorCode,
      "HELPER_DISCONNECTED",
    );
    const changed = captures.create(p.id, "SAME_ACCOUNT");
    profiles.revoke(p.id);
    assert.equal(captures.get(changed.id).status, "CANCELLED");
    const cancelled = captures.create(p.id, "SAME_ACCOUNT"),
      pair = captures.pair(cancelled.pairingCode);
    captures.save(cancelled.id);
    f.state.delay = 100;
    const pending = captures.submit(cancelled.id, pair.helperToken, {
      cookies: f.cookie(),
      origins: [],
    });
    captures.cancel(cancelled.id);
    await assert.rejects(pending);
    assert.equal(profiles.get(p.id).status, "EMPTY");
    const restarted = captures.create(p.id, "SAME_ACCOUNT");
    await captures.stop();
    assert.throws(() => captures.get(restarted.id), {
      code: "CAPTURE_NOT_FOUND",
    });
  } finally {
    await captures.stop();
    await app.close();
    await f.close();
  }
});
test("real helper opens an isolated context, waits without uploading and cleans up on cancellation", async () => {
  const f = await authFixture(),
    { app, profiles, captures } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
    });
  let browser: Browser | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 }),
      p = await profiles.create(f.profile),
      c = captures.create(p.id, "SAME_ACCOUNT");
    let opened!: () => void;
    const windowOpen = new Promise<void>((r) => {
      opened = r;
    });
    const running = runLoginHelper(address, c.pairingCode, {
      launch: async () => {
        browser = await chromium.launch({ headless: true });
        return browser;
      },
      validateUrl: (url) => assertPublicUrl(url, ["127.0.0.1"]),
      onWindow: async (page) => {
        await Promise.all([
          page.waitForURL(f.url + "/private"),
          page.getByRole("button").click(),
        ]);
        opened();
      },
    });
    await windowOpen;
    assert.equal(profiles.get(p.id).status, "EMPTY");
    captures.cancel(c.id);
    assert.equal((await running).completed, false);
    assert.equal(browser!.isConnected(), false);
    assert.equal(profiles.get(p.id).status, "EMPTY");
    for (const url of [
      "http://remote.example.com",
      "https://u:p@example.com",
      "https://example.com/?token=x",
    ])
      assert.throws(() => helperServer(url));
  } finally {
    await browser?.close();
    await app.close();
    await f.close();
  }
});

test("real helper allows approved SSO popups and rejects unapproved popup navigation before upload", async () => {
  const { createServer } = await import("node:http");
  const f = await authFixture();
  const sso = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<button onclick="location.href='${f.url}/sso-callback'">完成 SSO</button>`,
    );
  });
  await new Promise<void>((resolve) => sso.listen(0, "127.0.0.1", resolve));
  const address = sso.address() as { port: number };
  const ssoUrl = `http://sso.example.test:${address.port}`;
  f.state.loginHtml = `<button onclick="window.open('${ssoUrl}')">通过 SSO 登录</button>`;
  const { app, profiles, captures } = await createApp({
    databasePath: ":memory:",
    workers: false,
    ...credentials(),
    browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
  });
  try {
    const server = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const approved of [true, false]) {
      const p = await profiles.create({
        ...f.profile,
        allowedHosts: approved
          ? ["127.0.0.1", "sso.example.test"]
          : ["127.0.0.1"],
      });
      const c = captures.create(p.id, "SAME_ACCOUNT");
      let browser!: Browser;
      const result = await runLoginHelper(server, c.pairingCode, {
        launch: async () => {
          browser = await chromium.launch({
            headless: true,
            proxy: {
              server: `http://127.0.0.1:${address.port}`,
              bypass: "127.0.0.1",
            },
          });
          return browser;
        },
        validateUrl: (url) =>
          assertPublicUrl(url, ["127.0.0.1", "sso.example.test"]),
        onWindow: async (page) => {
          const popup = page.waitForEvent("popup");
          await page.getByRole("button", { name: "通过 SSO 登录" }).click();
          const child = await popup;
          if (approved) {
            await child
              .getByRole("button", { name: "完成 SSO" })
              .click({ timeout: 3000 });
            await page.waitForURL(f.url + "/private");
            assert.equal(profiles.get(p.id).status, "EMPTY");
            captures.save(c.id);
          } else {
            if (!child.isClosed()) await child.waitForEvent("close");
            assert.equal(page.url(), f.url + "/login");
            captures.cancel(c.id);
          }
        },
      });
      assert.equal(result.completed, approved);
      assert.equal(profiles.get(p.id).status, approved ? "READY" : "EMPTY");
      assert.equal(browser.isConnected(), false);
    }
  } finally {
    await app.close();
    await f.close();
    await new Promise<void>((resolve) => sso.close(() => resolve()));
  }
});

test(
  "helper closes its real browser after thirty seconds of actual service network loss",
  { timeout: 45_000 },
  async () => {
    const f = await authFixture(),
      { app, profiles, captures } = await createApp({
        databasePath: ":memory:",
        workers: false,
        ...credentials(),
        browserOptions: { allowedHosts: ["127.0.0.1"] },
      });
    let browser!: Browser, resume!: () => void, opened!: () => void;
    const paused = new Promise<void>((r) => {
        resume = r;
      }),
      windowOpen = new Promise<void>((r) => {
        opened = r;
      });
    try {
      const server = await app.listen({ host: "127.0.0.1", port: 0 }),
        p = await profiles.create(f.profile),
        c = captures.create(p.id, "SAME_ACCOUNT");
      const running = runLoginHelper(server, c.pairingCode, {
        launch: async () => {
          browser = await chromium.launch({ headless: true });
          return browser;
        },
        validateUrl: (url) => assertPublicUrl(url, ["127.0.0.1"]),
        onWindow: async () => {
          opened();
          await paused;
        },
      });
      await windowOpen;
      await new Promise<void>((resolve) => {
        app.server.close(() => resolve());
        app.server.closeAllConnections();
      });
      const disconnectedAt = Date.now();
      resume();
      await assert.rejects(running, { code: "HELPER_DISCONNECTED" });
      assert.ok(Date.now() - disconnectedAt < 35_000);
      assert.equal(browser.isConnected(), false);
      assert.equal(profiles.get(p.id).status, "EMPTY");
    } finally {
      resume();
      await browser?.close();
      await app.close();
      await f.close();
    }
  },
);

test("helper receives committed success while bound-task recovery is still pending", async () => {
  const f = await authFixture(),
    { app, profiles, captures } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...credentials(),
      browserOptions: { allowedHosts: ["127.0.0.1"], targetTimeoutMs: 100 },
    });
  let resume!: () => void, entered!: () => void;
  const recovery = new Promise<void>((r) => {
      resume = r;
    }),
    recovering = new Promise<void>((r) => {
      entered = r;
    });
  let pending: Promise<unknown> | undefined;
  try {
    const p = await profiles.create(f.profile),
      c = captures.create(p.id, "SAME_ACCOUNT"),
      pair = captures.pair(c.pairingCode);
    profiles.onVerified = async () => {
      entered();
      await recovery;
    };
    captures.save(c.id);
    pending = captures.submit(c.id, pair.helperToken, {
      cookies: f.cookie(),
      origins: [],
    });
    await recovering;
    const completed = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
    ]);
    assert.equal(
      completed,
      true,
      "slow bound-task recovery must not make a committed helper save time out",
    );
    assert.equal(captures.get(c.id).status, "COMPLETED");
    assert.equal(profiles.get(p.id).status, "READY");
  } finally {
    resume();
    await pending?.catch(() => {});
    await app.close();
    await f.close();
  }
});
