import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { installDashboardAuth } from "../utils/dashboardAuth.ts";
import { Webhooks } from "@octokit/webhooks";
import { createWebhookApp } from "../utils/createWebhookApp.ts";
import { createDashboardApp } from "../utils/createDashboardApp.ts";
import { settings } from "../settings.ts";
import { request as httpRequest } from "node:http";

test("combined LAN listener accepts same-origin login and signed webhooks on one port", async t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.DASHBOARD_USERNAME = "lan-user";
  process.env.DASHBOARD_PASSWORD = "lan-password";
  const hooks = new Webhooks({ secret: "test-webhook-secret" });
  const app = createWebhookApp(hooks);
  app.use(createDashboardApp({ load: () => [] }, undefined, { allowLan: true }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = `192.168.1.20:${server.address().port}`;
  // Node fetch may normalize Host; use HTTP directly to simulate a LAN browser.
  const fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(url, options, res => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: {
        get: name => Array.isArray(res.headers[name]) ? res.headers[name][0] : res.headers[name],
      } }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
  assert.equal((await fetch(`${base}/api/agents`, { headers: { Host: host } })).status, 401);
  const login = origin => fetch(`${base}/api/auth/login`, { method: "POST",
    headers: { Host: host, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "lan-user", password: "lan-password" }) });
  assert.equal((await login("http://192.168.1.21")).status, 403);
  const signedIn = await login(`http://${host}`);
  assert.equal(signedIn.status, 200);
  assert.equal((await fetch(`${base}/api/agents`, { headers: { Host: host, Cookie: signedIn.headers.get("set-cookie").split(";")[0] } })).status, 200);
  const body = JSON.stringify({ zen: "test" });
  const delivery = await fetch(`${base}${settings.server.webhookPath}`, { method: "POST", body,
    headers: { Host: host, "Content-Type": "application/json", "x-github-event": "ping", "x-github-delivery": "lan-test", "x-hub-signature-256": await hooks.sign(body) } });
  assert.equal(delivery.status, 200);
});

test("dashboard login protects API, issues private cookies, rejects cross-site login, and revokes logout", async t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.DASHBOARD_USERNAME = "test-user";
  process.env.DASHBOARD_PASSWORD = "test-password";
  const app = express();
  app.use(express.json());
  installDashboardAuth(app);
  app.get("/api/settings", (_req, res) => res.json({ protected: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (password, origin) => fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ username: "test-user", password }),
  });
  for (const route of ["settings", "agents", "events", "auth/session"]) assert.equal((await fetch(`${base}/api/${route}`)).status, 401);
  assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("test-password", "https://example.com")).status, 403);
  const success = await login("test-password");
  assert.equal(success.status, 200);
  const setCookie = success.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const headers = { Cookie: setCookie.split(";")[0] };
  assert.equal((await fetch(`${base}/api/settings`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers })).status, 200);
  assert.equal((await fetch(`${base}/api/settings`, { headers })).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("test-password")).status, 429);
});

test("missing dashboard credentials fail closed", async t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  delete process.env.DASHBOARD_USERNAME;
  delete process.env.DASHBOARD_PASSWORD;
  const app = express(); app.use(express.json()); installDashboardAuth(app);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
});
