// A disposable, real service for manual UI acceptance. The private-address
// exception is injected here only; the production entry point has no such flag.
import { createApp } from "../server/src/app.js";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { startFixture } from "./fixtures.js";
const fixture = await startFixture();
const seed = process.argv.includes("--seed");
const authMode = process.argv.includes("--auth");
const { authFixture } = await import("./auth-fixtures.js");
const auth = authMode ? await authFixture() : null;
// Disposable acceptance token, never used by production or real identities.
const authConfig = authMode
  ? {
      adminToken: "ui-acceptance-token-not-for-production-2026",
      authMasterKey: Buffer.alloc(32, 7).toString("base64"),
    }
  : {};
const { app, service, profiles } = await createApp({
  ...authConfig,
  databasePath: ":memory:",
  collector: new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 100,
  }),
});
if (seed) {
  const article = (lines: string[]) =>
    `<article>${lines.map((line) => `<p>${line}</p>`).join("")}</article>`;
  const text = service.create({
    name: "示例 · Nova 产品更新",
    url: fixture.url + "/custom",
    mode: "TEXT",
    selector: "article",
    intervalMinutes: 30,
    enabled: true,
  });
  fixture.state.html = article([
    "Nova 2.4 更新日志",
    "全新看板工作区",
    "支持 12 个监控任务",
    "修复通知重试问题",
    "支持 Linux 与 macOS",
  ]);
  await service.check(text.id);
  fixture.state.html = article([
    "Nova 2.5 更新日志",
    "全新看板工作区",
    "新增并排变化对比",
    "新增独立的内容速览",
    "支持 20 个监控任务",
    "修复通知重试问题",
    "支持 Linux 与 macOS",
  ]);
  await service.check(text.id);
  const list = service.create({
    name: "示例 · 设计灵感新文章",
    url: fixture.url + "/list",
    mode: "LIST",
    selector: "li",
    titleSelector: "a",
    linkSelector: "a",
    intervalMinutes: 15,
    enabled: true,
  });
  await service.check(list.id);
  fixture.state.items = ["D", "A", "B"];
  await service.check(list.id);
  const paused = service.create({
    name: "示例 · 软件版本",
    url: fixture.url,
    mode: "TEXT",
    selector: "article",
    intervalMinutes: 60,
    enabled: false,
  });
  await service.check(paused.id);
  fixture.state.status = 403;
  const failed = service.create({
    name: "示例 · 访问受限页面",
    url: fixture.url,
    mode: "TEXT",
    selector: "main",
    intervalMinutes: 30,
    enabled: true,
  });
  await service.check(failed.id);
  fixture.state.status = 200;
  const deleted = service.create({
    name: "示例 · 仅删除的变化",
    url: fixture.url + "/custom",
    mode: "TEXT",
    selector: "article",
    intervalMinutes: 180,
    enabled: false,
  });
  fixture.state.html = article(["保留的说明", "已过期的活动", "使用帮助"]);
  await service.check(deleted.id);
  fixture.state.html = article(["保留的说明", "使用帮助"]);
  await service.check(deleted.id);
  console.log(`Seeded TEXT detail: http://127.0.0.1:4173/monitors/${text.id}`);
  console.log(`Seeded LIST detail: http://127.0.0.1:4173/monitors/${list.id}`);
  console.log(
    `Deletion-only detail: http://127.0.0.1:4173/monitors/${deleted.id}`,
  );
}
if (auth) {
  const p = await profiles.create(auth.profile);
  await profiles.importState(p.id, auth.cookie(), "SAME_ACCOUNT");
  const m = service.create({
    name: "受控 · 私密动态",
    url: auth.url + "/private",
    mode: "TEXT",
    selector: "article",
    intervalMinutes: 30,
    enabled: false,
    authProfileId: p.id,
  });
  await service.check(m.id);
  console.log(
    `Auth acceptance target: ${auth.url}; management protection enabled`,
  );
}
await app.listen({ port: 4173, host: "127.0.0.1" });
console.log(
  `UI acceptance: http://127.0.0.1:4173; controlled target: ${fixture.url}`,
);
process.on("SIGINT", () => {
  void app
    .close()
    .then(() => fixture.close())
    .then(() => auth?.close())
    .then(() => process.exit(0));
});
