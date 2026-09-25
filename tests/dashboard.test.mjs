import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkerStore } from "../classes/WorkerStore.ts";
import { createDashboardApp } from "../utils/createDashboardApp.ts";
import { settings } from "../settings.ts";

test("dashboard exposes agent history and rejects invalid live settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-worker-dashboard-"));
  const store = new WorkerStore(path.join(directory, "dashboard.sqlite"));
  store.save({ role: "coder", agentId: "issue-3", workerId: "worker-3", type: "codex", root: null, initialized: true, status: "working", conversationId: "thread-3", pending: ["fix issue"] });
  store.appendEvent("worker-3", "prompt", "fix issue");
  const server = createDashboardApp(store).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const agents = await (await fetch(`${base}/api/agents`)).json();
    assert.equal(agents[0].workerId, "worker-3");
    const events = await (await fetch(`${base}/api/agents/worker-3/events`)).json();
    assert.equal(events[0].message, "fix issue");
    const live = await fetch(`${base}/api/settings`);
    assert.equal((await live.json()).github.username, settings.github.username);
    const invalid = structuredClone(settings);
    invalid.server.port += 1;
    const response = await fetch(`${base}/api/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /require a restart/);
    assert.equal(settings.server.port, invalid.server.port - 1);
    const unknown = await fetch(`${base}/api/agents/missing/events`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
