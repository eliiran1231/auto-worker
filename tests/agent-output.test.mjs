import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "../classes/Worker.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("Codex displays messages before completion and reuses its thread", async (t) => {
  const output = t.mock.method(console, "info", () => {});
  const worker = new Worker("codex", undefined, "coder");
  const gate = Promise.withResolvers();
  let starts = 0;
  const prompts = [];
  worker.codex = { startThread() {
    starts++;
    return { id: "thread-123", async runStreamed(prompt) {
      prompts.push(prompt);
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "thread-123" };
        yield { type: "item.completed", item: { type: "agent_message", text: "I found the failing test.\nI will fix it now." } };
        yield { type: "item.completed", item: { type: "reasoning", text: "not an assistant message" } };
        await gate.promise;
        yield { type: "turn.completed" };
      })() };
    } };
  } };
  const first = worker.spawn("first");
  await tick();
  const lines = output.mock.calls.map(call => call.arguments[0]);
  assert.ok(lines.some(line => line.includes("[CODER codex") && line.endsWith("I found the failing test.")));
  assert.ok(lines.some(line => line.includes("[CODER codex") && line.endsWith("I will fix it now.")));
  assert.ok(!lines.some(line => line.includes("not an assistant message")));
  assert.equal(worker.status, "working");
  assert.equal(worker.conversationId, "thread-123");
  gate.resolve();
  await first;
  await worker.send("follow-up");
  assert.deepEqual(prompts, ["first", "follow-up"]);
  assert.equal(starts, 1);
  assert.equal(worker.status, "idle");
});

test("Claude displays assistant and tool messages, avoids duplicate final text, and resumes", async (t) => {
  const old = process.env.REVIEWER_GITHUB_TOKEN;
  process.env.REVIEWER_GITHUB_TOKEN = "reviewer-test-secret";
  t.after(() => { if (old === undefined) delete process.env.REVIEWER_GITHUB_TOKEN; else process.env.REVIEWER_GITHUB_TOKEN = old; });
  const output = t.mock.method(console, "info", () => {});
  const worker = new Worker("claude", undefined, "reviewer");
  const gate = Promise.withResolvers();
  const options = [];
  worker.queryClaude = (args) => {
    options.push(args.options);
    return (async function* () {
      yield { type: "assistant", session_id: "session-123", message: { content: [
        { type: "text", text: "Reviewing the changes reviewer-test-secret" },
        { type: "tool_use", name: "Read" },
      ] } };
      await gate.promise;
      yield { type: "result", subtype: "success", is_error: false, result: "Reviewing the changes reviewer-test-secret" };
    })();
  };
  const first = worker.spawn("review");
  await tick();
  assert.equal(worker.status, "working");
  assert.equal(worker.conversationId, "session-123");
  gate.resolve();
  await first;
  const lines = output.mock.calls.map(call => call.arguments[0]);
  assert.equal(lines.filter(line => line.includes("Reviewing the changes")).length, 1);
  assert.ok(lines.some(line => line.includes("[REVIEWER claude") && line.includes("[REDACTED]")));
  assert.ok(lines.some(line => line.endsWith("Using tool: Read")));
  await worker.send("review again");
  assert.equal(options[0].resume, undefined);
  assert.equal(options[1].resume, "session-123");
});

test("a failed Codex streamed turn still rejects and marks the worker as errored", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const worker = new Worker("codex", undefined, "tester");
  worker.codex = { startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: "turn.failed", error: { message: "stream failed" } };
  })() }) }) };
  await assert.rejects(worker.spawn("test"), /stream failed/);
  assert.equal(worker.status, "error");
});
