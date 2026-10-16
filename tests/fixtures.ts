import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function startFixture() {
  const state = {
    text: "版本 v1",
    stamp: "今天",
    items: ["A", "B", "C"],
    status: 200,
    delay: 350,
    html: "",
    notifyStatus: 200,
    notifyDelay: 0,
    deliveries: [] as string[],
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/ntfy") {
      let body = "";
      for await (const chunk of req) body += chunk;
      state.deliveries.push(body);
      if (state.notifyDelay)
        await new Promise((resolve) => setTimeout(resolve, state.notifyDelay));
      res.writeHead(state.notifyStatus);
      res.end("ok");
      return;
    }
    res.writeHead(state.status, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/custom") res.end(state.html);
    else if (req.url === "/list")
      res.end(
        `<ul>${state.items.map((x) => `<li><a href="/item/${x}?type=1#top">条目 ${x}</a></li>`).join("")}</ul>`,
      );
    else if (req.url === "/spa")
      res.end(
        `<main></main><script>setTimeout(() => document.querySelector('main').innerHTML = '<article>${state.text}</article>', ${state.delay})</script>`,
      );
    else
      res.end(
        `<main><article>${state.text}<span class="stamp">${state.stamp}</span><span hidden>hidden</span><span style="display:none">invisible</span></article></main>`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
