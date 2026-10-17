import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/src/app.js";
import {
  encryptState,
  decryptState,
  parseMasterKey,
} from "../server/src/auth/crypto.js";

export const credentials = () => ({
  adminToken: randomBytes(32).toString("base64"),
  authMasterKey: randomBytes(32).toString("base64"),
});
export async function unlock(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  token: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/session",
    payload: { token },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: String(response.headers["set-cookie"]).split(";")[0],
    "x-csrf-token": response.json().csrfToken,
  };
}
test("AES-GCM binds identity and revision, rejects corruption and hides fixture secret", () => {
  const key = randomBytes(32),
    state = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "fixture", value: "fixture-secret-only" }],
        },
      ],
    };
  const first = encryptState("id", 1, state, key),
    second = encryptState("id", 1, state, key);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes("fixture-secret-only"));
  assert.deepEqual(decryptState("id", 1, first, key), state);
  for (const fn of [
    () => decryptState("id", 2, first, key),
    () => decryptState("other", 1, first, key),
    () => decryptState("id", 1, first, randomBytes(32)),
    () =>
      decryptState(
        "id",
        1,
        { ...first, tag: randomBytes(16).toString("base64") },
        key,
      ),
  ])
    assert.throws(fn, { code: "AUTH_STATE_UNAVAILABLE" });
  assert.throws(() => parseMasterKey("bad"), { code: "AUTH_CONFIG" });
});
test("management protects all private reads and CSRF writes; logout revokes session", async () => {
  const config = credentials(),
    { app } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...config,
    });
  try {
    const id = randomUUID();
    for (const url of [
      "/api/monitors",
      `/api/monitors/${id}/current`,
      `/api/monitors/${id}/thumbnail`,
      "/api/updates",
      "/api/settings",
    ])
      assert.equal((await app.inject(url)).statusCode, 401, url);
    assert.deepEqual((await app.inject("/api/health")).json(), {
      status: "ok",
    });
    const headers = await unlock(app, config.adminToken);
    const cookie = (
      await app.inject({
        method: "POST",
        url: "/api/admin/session",
        payload: { token: config.adminToken },
        headers: { host: "localhost", origin: "https://localhost" },
      })
    ).headers["set-cookie"];
    assert.match(String(cookie), /HttpOnly; SameSite=Strict.*Secure/);
    assert.equal(
      (await app.inject({ url: "/api/monitors", headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors/check-all",
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors/check-all",
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/admin/session",
          headers,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await app.inject({ url: "/api/monitors", headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("protection persists with zero identities; restart revokes sessions and missing keys fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-auth-security-")),
    databasePath = join(dir, "test.sqlite"),
    config = credentials();
  try {
    const first = await createApp({ databasePath, workers: false, ...config });
    const headers = await unlock(first.app, config.adminToken);
    await first.app.close();
    await assert.rejects(createApp({ databasePath, workers: false }), {
      code: "AUTH_CONFIG",
    });
    await assert.rejects(
      createApp({
        databasePath,
        workers: false,
        adminToken: config.adminToken,
      }),
      { code: "AUTH_CONFIG" },
    );
    const next = await createApp({ databasePath, workers: false, ...config });
    try {
      assert.equal(
        (await next.app.inject({ url: "/api/updates", headers })).statusCode,
        401,
      );
    } finally {
      await next.app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("management login limits guesses and expires sessions after twelve hours", async (t) => {
  const config = credentials(),
    { app } = await createApp({
      databasePath: ":memory:",
      workers: false,
      ...config,
    });
  try {
    const headers = await unlock(app, config.adminToken);
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.now() + 12 * 60 * 60_000 + 1,
    });
    assert.equal(
      (await app.inject({ url: "/api/monitors", headers })).statusCode,
      401,
    );
    t.mock.timers.reset();
    for (let i = 0; i < 4; i++)
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/session",
            payload: { token: "invalid-guess" },
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/session",
          payload: { token: "invalid-guess" },
        })
      ).statusCode,
      429,
    );
    for (const url of [
      "/%61pi/monitors",
      "/api/%6donitors",
      "/api/monitors?x=1",
    ])
      assert.ok([401, 404].includes((await app.inject(url)).statusCode));
  } finally {
    t.mock.timers.reset();
    await app.close();
  }
});
