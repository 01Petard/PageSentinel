import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import config from "../vite.config.js";
import { createApp } from "../server/src/app.js";
import { startFixture } from "./fixtures.js";

test("real Vite proxy preserves browser origin for preview/create while rejecting foreign origins", async () => {
  const fixture = await startFixture();
  const { app, service } = await createApp({
    databasePath: ":memory:",
    workers: false,
    browserOptions: { allowedHosts: ["127.0.0.1"], sampleIntervalMs: 30 },
  });
  const backend = await app.listen({ host: "127.0.0.1", port: 0 });
  const configured = config.server!.proxy!["/api"]!;
  // Retain the repository's string/object form and all proxy behavior while
  // directing this disposable frontend at its own disposable backend.
  const proxy =
    typeof configured === "string"
      ? backend
      : { ...configured, target: backend };
  const vite = await createServer({
    ...config,
    configFile: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: null,
      proxy: { "/api": proxy },
    },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const rule = {
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      ignoreSelectors: [".stamp"],
    };
    for (const host of ["127.0.0.1", "localhost"]) {
      const base = `http://${host}:${port}`;
      const headers = {
        "content-type": "application/json",
        origin: `http://${host}:${port}`,
      };
      const preview = await fetch(base + "/api/monitors/test", {
        method: "POST",
        headers,
        body: JSON.stringify(rule),
      });
      assert.equal(preview.status, 200, await preview.clone().text());
      assert.equal((await preview.json()).text, "版本 v1");
      const created = await fetch(base + "/api/monitors", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...rule,
          name: "本地代理回归",
          intervalMinutes: 30,
          enabled: false,
        }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      const monitor = await created.json();
      await service.drain();
      assert.equal(service.get(monitor.id).lastStatus, "BASELINE");
      for (const origin of [
        "https://evil.example",
        `http://${host}:${port + 1}`,
      ]) {
        const rejected = await fetch(base + "/api/monitors", {
          method: "POST",
          headers: { ...headers, origin },
          body: JSON.stringify({
            ...rule,
            name: "不应创建",
            intervalMinutes: 30,
            enabled: false,
          }),
        });
        assert.equal(rejected.status, 403);
        assert.equal((await rejected.json()).code, "CROSS_ORIGIN");
      }
    }
    assert.equal(service.list().length, 2);
  } finally {
    await vite.close();
    await app.close();
    await fixture.close();
  }
});
