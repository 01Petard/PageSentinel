import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import type { AddressInfo } from "node:net";
import config from "../vite.config.js";
import { createApp } from "../server/src/app.js";
import { authFixture, credentials } from "./auth-fixtures.js";

test("first access failure leads through login configuration, verification and binding without losing task context", async () => {
  const fixture = await authFixture();
  const keys = credentials();
  const { app, service } = await createApp({
    ...keys,
    databasePath: ":memory:",
    workers: false,
    browserOptions: { allowedHosts: ["127.0.0.1"], sampleIntervalMs: 30 },
  });
  const backend = await app.listen({ host: "127.0.0.1", port: 0 });
  const vite = await createServer({
    ...config,
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: null,
      proxy: { "/api": { target: backend, changeOrigin: false } },
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const monitor = service.create({
      name: "需要登录的真实流程",
      url: fixture.url + "/member-only",
      mode: "TEXT",
      selector: "article",
      intervalMinutes: 30,
      enabled: false,
    });
    await service.check(monitor.id);
    assert.equal(service.get(monitor.id).lastStatus, "FAILED");
    await vite.listen();
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${base}/monitors/${monitor.id}`);
    await page.getByRole("textbox", { name: "管理令牌" }).fill(keys.adminToken);
    await page.getByRole("button", { name: "解锁管理入口" }).click();
    await page
      .getByText("尚未成功采集，尚未建立对比基线。", { exact: false })
      .waitFor();
    await page
      .getByRole("link", { name: "配置登录并重试", exact: true })
      .click();
    await page
      .getByRole("button", { name: "新建登录身份", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "验证 URL", exact: true })
        .inputValue(),
      monitor.url,
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "批准主机", exact: true })
        .inputValue(),
      "127.0.0.1",
    );
    await page
      .getByRole("textbox", { name: "登录 URL", exact: true })
      .fill(fixture.profile.loginUrl);
    await page
      .getByRole("textbox", { name: "登录成功标记 CSS", exact: true })
      .fill("#member");
    await page.getByRole("button", { name: "保存身份配置" }).click();
    await page
      .getByRole("tab", { name: "专用窗口登录", exact: true })
      .waitFor({ state: "visible" });
    await page.getByRole("tab", { name: "导入状态", exact: true }).click();
    await page
      .getByRole("combobox", { name: "账号更新方式", exact: true })
      .selectOption("SAME_ACCOUNT");
    await page
      .getByRole("textbox", { name: "登录状态内容", exact: true })
      .fill("session=fixture-A");
    await page
      .getByRole("button", { name: "验证并保存登录状态", exact: true })
      .click();
    await page
      .getByText("部署端验证通过，状态已加密保存。", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "绑定身份并重新检查", exact: true })
      .click();
    await page.waitForURL(`${base}/monitors/${monitor.id}`);
    await page.getByText("最新成功采集", { exact: true }).waitFor();
    const updated = service.get(monitor.id);
    assert.ok(updated.authProfileId);
    assert.equal(updated.lastStatus, "BASELINE");
    assert.equal(updated.enabled, false);
    assert.equal(service.list().length, 1);
  } finally {
    await browser.close();
    await vite.close();
    await app.close();
    await fixture.close();
  }
});
