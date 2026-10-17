import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { createApp } from "../server/src/app.js";

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
export async function authFixture() {
  const state = {
    text: "private-fixture-v1",
    valid: true,
    rotate: false,
    delay: 0,
    marker: true,
    status: 200,
    deliveries: [] as string[],
    notifyStatus: 200,
    loginHtml: "",
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/ntfy") {
      let body = "";
      for await (const chunk of req) body += chunk;
      state.deliveries.push(body);
      res.writeHead(state.notifyStatus).end();
      return;
    }
    if (state.delay)
      await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (req.url === "/login") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        state.loginHtml ||
          '<form method="POST" action="/sign-in"><button>完成受控登录</button></form>',
      );
      return;
    }
    if (req.url === "/sign-in") {
      res
        .writeHead(302, {
          "set-cookie": "session=fixture-A; Path=/; HttpOnly; SameSite=Lax",
          location: "/private",
        })
        .end();
      return;
    }
    if (req.url === "/sso-callback") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader(
        "set-cookie",
        "session=fixture-A; Path=/; HttpOnly; SameSite=Lax",
      );
      res.end(
        "<script>if(window.opener){window.opener.location='/private';window.close()}else{location='/private'}</script>",
      );
      return;
    }
    if (req.url === "/denied") {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/login" }).end();
      return;
    }
    if (req.url === "/ls" || req.url === "/idb") {
      const script =
        req.url === "/ls"
          ? 'if(localStorage.getItem("session")==="fixture-LS")document.body.innerHTML="<b id=member>member</b><article>local private</article>"'
          : 'const r=indexedDB.open("auth",1);r.onsuccess=()=>{const d=r.result;if(!d.objectStoreNames.contains("tokens"))return;const t=d.transaction("tokens").objectStore("tokens").get("session");t.onsuccess=()=>{if(t.result==="fixture-IDB")document.body.innerHTML="<b id=member>member</b><article>idb private</article>"}}';
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<body>login<script>${script}</script>`);
      return;
    }
    if (state.status !== 200) {
      res.writeHead(state.status).end();
      return;
    }
    const matched = /session=(fixture-[AB]|rotated)/.exec(
      req.headers.cookie ?? "",
    );
    if (!matched && req.url === "/member-only") {
      res.writeHead(403).end("login required");
      return;
    }
    if (!state.valid || !matched) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<form>HTTP 200 login page</form>");
      return;
    }
    if (state.rotate)
      res.setHeader(
        "set-cookie",
        "session=rotated; HttpOnly; Path=/; SameSite=Lax",
      );
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `${state.marker ? '<b id="member">member</b>' : ""}<article>${matched[1] === "fixture-A" ? "account-A" : matched[1] === "fixture-B" ? "account-B" : "account-rotated"} ${state.text}</article><ul><li><a href="/item/1">private item</a></li></ul>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const profile = {
    name: "受控身份",
    loginUrl: url + "/login",
    verificationUrl: url + "/private",
    allowedHosts: ["127.0.0.1"],
    successSelector: "#member",
    loginUrlPrefix: url + "/login",
  };
  return {
    state,
    url,
    profile,
    cookie: (value = "fixture-A") => [
      {
        name: "session",
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
