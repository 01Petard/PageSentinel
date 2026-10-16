import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserCollector } from "../server/src/monitor/browser.js";
import { startFixture } from "./fixtures.js";

test("real Chromium: static text, exclusions, delayed SPA and LIST extraction", async () => {
  const fixture = await startFixture();
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 100,
    stabilityTimeoutMs: 2000,
  });
  try {
    const text = await browser.collect({
      url: fixture.url,
      mode: "TEXT",
      selector: "article",
      ignoreSelectors: [".stamp"],
    });
    assert.equal(text.mode, "TEXT");
    if (text.mode === "TEXT") assert.equal(text.text, "版本 v1");
    const spa = await browser.collect({
      url: fixture.url + "/spa",
      mode: "TEXT",
      selector: "article",
    });
    assert.equal(spa.mode === "TEXT" && spa.text, "版本 v1");
    const list = await browser.collect({
      url: fixture.url + "/list",
      mode: "LIST",
      selector: "li",
      titleSelector: "a",
      linkSelector: "a",
    });
    assert.equal(list.mode === "LIST" && list.items.length, 3);
    assert.equal(browser.activeContexts, 0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("real Chromium rejects ambiguous/empty/oversized/duplicate results and HTTP errors", async () => {
  const fixture = await startFixture();
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 30,
    targetTimeoutMs: 250,
    stabilityTimeoutMs: 350,
  });
  try {
    const rule = {
      url: fixture.url + "/custom",
      mode: "TEXT" as const,
      selector: "article",
    };
    fixture.state.html = "<article>A</article><article>B</article>";
    await assert.rejects(browser.collect(rule), { code: "MATCH_COUNT" });
    fixture.state.html = "<article></article>";
    await assert.rejects(browser.collect(rule), { code: "EMPTY_TEXT" });
    fixture.state.html =
      '<section style="display:none"><article>不可见</article></section>';
    await assert.rejects(browser.collect(rule), { code: "EMPTY_TEXT" });
    fixture.state.html = "<article>" + "中".repeat(90000) + "</article>";
    await assert.rejects(browser.collect(rule), { code: "TEXT_LIMIT" });
    const list = {
      ...rule,
      mode: "LIST" as const,
      selector: "li",
      linkSelector: "a",
    };
    fixture.state.html =
      '<li><a href="/a">A</a></li><li><a href="/a#x">A</a></li>';
    await assert.rejects(browser.collect(list), { code: "DUPLICATE_KEY" });
    fixture.state.html = "<li>no link</li>";
    await assert.rejects(browser.collect(list), { code: "MISSING_LINK" });
    fixture.state.html = Array.from(
      { length: 201 },
      (_, i) => `<li><a href="/${i}">${i}</a></li>`,
    ).join("");
    await assert.rejects(browser.collect(list), { code: "LIST_LIMIT" });
    fixture.state.html = "<ul></ul>";
    await assert.rejects(browser.collect(list), { code: "TARGET_TIMEOUT" });
    fixture.state.status = 429;
    await assert.rejects(browser.collect(rule), { code: "HTTP_429" });
    assert.equal(browser.activeContexts, 0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("public-only browser rejects private destinations", async () => {
  const browser = new BrowserCollector();
  await assert.rejects(
    browser.collect({
      url: "http://127.0.0.1",
      mode: "TEXT",
      selector: "main",
    }),
    { code: "PRIVATE_ADDRESS" },
  );
  await browser.close();
});

test("LIST resolves relative links using the document base URL", async () => {
  const fixture = await startFixture();
  fixture.state.html =
    '<base href="/news/"><ul><li><a href="post-1">Article</a></li></ul>';
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 30,
  });
  try {
    const result = await browser.collect({
      url: fixture.url + "/custom",
      mode: "LIST",
      selector: "li",
    });
    assert.equal(
      result.mode === "LIST" && result.items[0].url,
      fixture.url + "/news/post-1",
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("a page that blocks its renderer cannot hang collection indefinitely", async () => {
  const fixture = await startFixture();
  fixture.state.html =
    "<article>A</article><script>setTimeout(() => { while (true) {} }, 20)</script>";
  const browser = new BrowserCollector({
    allowedHosts: ["127.0.0.1"],
    sampleIntervalMs: 100,
    checkTimeoutMs: 600,
  });
  try {
    await assert.rejects(
      browser.collect({
        url: fixture.url + "/custom",
        mode: "TEXT",
        selector: "article",
      }),
      { code: "CHECK_TIMEOUT" },
    );
    assert.equal(browser.activeContexts, 0);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
