import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkerStore } from "../classes/WorkerStore.ts";
import { createDashboardApp } from "../utils/createDashboardApp.ts";
import { settings } from "../settings.ts";
import { Worker } from "../classes/Worker.ts";
import { AgentFactory } from "../AgentFactory.ts";

test("dashboard exposes agent history and rejects invalid live settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-worker-dashboard-"));
  const store = new WorkerStore(path.join(directory, "dashboard.sqlite"));
  store.save({ role: "coder", agentId: "issue-3", workerId: "worker-3", type: "codex", root: null, initialized: true, status: "working", conversationId: "thread-3", pending: ["fix issue"] });
  store.appendEvent("worker-3", "prompt", "fix issue");
  const scanRequests = [];
  const server = createDashboardApp(store, {
    async startTesterScan(owner, repo) {
      scanRequests.push({ owner, repo });
      return { repository: `${owner}/${repo}`, status: "started" };
    },
  }).listen(0, "127.0.0.1");
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
    const startScan = (repository, origin) => fetch(`${base}/api/tester-scans`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ repository }),
    });
    assert.equal((await startScan("https://github.com/owner/repo")).status, 400);
    assert.equal((await startScan("owner/repo", "https://example.com")).status, 403);
    assert.deepEqual(scanRequests, []);
    const started = await startScan(" owner/repo ");
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { repository: "owner/repo", status: "started" });
    assert.deepEqual(scanRequests, [{ owner: "owner", repo: "repo" }]);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard queues and persists messages for busy agents of every role", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-worker-messages-"));
  const store = new WorkerStore(path.join(directory, "workers.sqlite"));
  const server = createDashboardApp(store).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (workerId, message, origin) => fetch(`${base}/api/agents/${workerId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ message }),
  });
  try {
    for (const role of ["coder", "reviewer", "tester"]) {
      const worker = new Worker("codex", directory, role);
      const registry = AgentFactory[`${role}s`];
      registry["dashboard-test"] = worker;
      worker.attachStore(store, "dashboard-test");
      const gate = Promise.withResolvers();
      const finished = Promise.withResolvers();
      const prompts = [];
      t.mock.method(worker, "runCodexTurn", async prompt => {
        prompts.push(prompt);
        if (prompt === "original task") await gate.promise;
        else finished.resolve();
        return 0;
      });
      const first = worker.spawn("original task");
      try {
        assert.equal((await post(worker.workerId, " ")).status, 400);
        assert.equal((await post(worker.workerId, "x".repeat(32001))).status, 400);
        assert.equal((await post(worker.workerId, "blocked", "https://example.com")).status, 403);
        const accepted = await post(worker.workerId, "follow-up instructions");
        assert.equal(accepted.status, 202);
        assert.deepEqual(prompts, ["original task"]);
        assert.deepEqual(store.load().find(saved => saved.workerId === worker.workerId).pending, ["original task", "follow-up instructions"]);
        assert.ok(store.events(worker.workerId).some(event => event.kind === "prompt" && event.message.includes("follow-up instructions")));
        gate.resolve();
        await first;
        await finished.promise;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(prompts, ["original task", "follow-up instructions"]);
        store.delete(role, "dashboard-test");
        assert.equal((await post(worker.workerId, "too late")).status, 409);
      } finally {
        gate.resolve();
        await first;
        delete registry["dashboard-test"];
      }
    }
    assert.equal((await post("missing-worker", "hello")).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
