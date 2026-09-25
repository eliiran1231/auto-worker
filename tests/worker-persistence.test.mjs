import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "../classes/Worker.ts";
import { WorkerStore } from "../classes/WorkerStore.ts";

test("a queued turn and session survive a SQLite reopen", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-worker-state-"));
  const filename = path.join(directory, "workers.sqlite");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let store = new WorkerStore(filename);
  const original = new Worker("codex", directory, "coder");
  original.attachStore(store, "issue-1");
  const gate = Promise.withResolvers();
  t.mock.method(original, "runCodexTurn", async () => gate.promise);
  const running = original.spawn("fix the issue");
  original.conversationId = "thread-123";
  original.attachStore(store, "issue-1");
  assert.deepEqual(store.load()[0].pending, ["fix the issue"]);
  const snapshot = store.load()[0];
  gate.resolve(0);
  await running;
  store.save(snapshot);
  store.close();

  store = new WorkerStore(filename);
  const restored = new Worker("codex", undefined, "coder");
  restored.restore(store.load()[0], store);
  const prompts = [];
  t.mock.method(restored, "runCodexTurn", async prompt => { prompts.push(prompt); return 0; });
  assert.deepEqual(await restored.resumePendingTurns(), [0]);
  assert.deepEqual(prompts, ["fix the issue"]);
  assert.equal(restored.conversationId, "thread-123");
  assert.equal(store.load()[0].status, "idle");
  assert.deepEqual(store.load()[0].pending, []);
  store.close();
});
