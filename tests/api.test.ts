import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/src/app.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { startFixture } from "./fixtures.js";

test("REST management, real preview isolation, validation, pagination and deletion", async () => {
  const fixture = await startFixture();
  const { app, service } = await createApp({
    databasePath: ":memory:",
    workers: false,
    collector: new BrowserCollector({
      allowedHosts: ["127.0.0.1"],
      sampleIntervalMs: 30,
    }),
  });
  try {
    const rule = {
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      ignoreSelectors: [".stamp"],
    };
    const preview = await app.inject({
      method: "POST",
      url: "/api/monitors/test",
      payload: rule,
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().text, "版本 v1");
    assert.deepEqual((await app.inject("/api/monitors")).json(), []);
    const created = await app.inject({
      method: "POST",
      url: "/api/monitors",
      payload: {
        ...rule,
        name: "测试任务",
        intervalMinutes: 30,
        enabled: true,
      },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    await service.drain();
    assert.equal(
      (await app.inject(`/api/monitors/${id}`)).json().lastStatus,
      "BASELINE",
    );
    assert.equal(
      (await app.inject(`/api/monitors/${id}/events`)).json().total,
      0,
    );
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${id}`,
      payload: { enabled: false },
    });
    assert.equal(patch.json().enabled, false);
    fixture.state.text = "新版本";
    assert.equal(
      (
        await app.inject({ method: "POST", url: `/api/monitors/${id}/check` })
      ).json().status,
      "CHANGED",
    );
    assert.equal(
      (
        await app.inject(`/api/monitors/${id}/checks?pageIndex=1&pageSize=1`)
      ).json().items.length,
      1,
    );
    assert.equal(
      (await app.inject(`/api/monitors/${id}/checks?pageIndex=0`)).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/monitors/${id}`,
          payload: { intervalMinutes: 0 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors/test",
          payload: { ...rule, url: "file:///etc/passwd" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors/test",
          headers: { origin: "https://evil.example" },
          payload: rule,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/monitors",
          headers: { host: "evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/monitors/${id}` }))
        .statusCode,
      204,
    );
    assert.equal((await app.inject(`/api/monitors/${id}`)).statusCode, 404);
  } finally {
    await app.close();
    await fixture.close();
  }
});
