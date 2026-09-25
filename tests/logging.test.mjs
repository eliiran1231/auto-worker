import assert from "node:assert/strict";
import { test } from "node:test";
import { logger, withLogContext } from "../utils/logger.ts";
import { Worker } from "../classes/Worker.ts";

test("logs redact secrets and Git authorization while omitting error request payloads", (t) => {
  const previous = process.env.TESTER_GITHUB_TOKEN;
  process.env.TESTER_GITHUB_TOKEN = 'synthetic-credential-"with-quotes"';
  t.after(() => { if (previous === undefined) delete process.env.TESTER_GITHUB_TOKEN; else process.env.TESTER_GITHUB_TOKEN = previous; });
  const output = t.mock.method(console, "error", () => {});
  const secret = process.env.TESTER_GITHUB_TOKEN;
  const encoded = Buffer.from(`x-access-token:${secret}`).toString("base64");
  const error = new Error(`Request failed: ${secret} ${encoded}`);
  error.request = { body: "PRIVATE_PAYLOAD_MUST_NOT_APPEAR" };
  logger.error("Operation failed", { error: new AggregateError([error], "failed"), token: "another-secret" });
  const line = output.mock.calls[0].arguments[0];
  assert.ok(line.includes("[REDACTED]"));
  for (const forbidden of ["synthetic-credential", encoded, "PRIVATE_PAYLOAD_MUST_NOT_APPEAR", "another-secret"]) assert.ok(!line.includes(forbidden));
  assert.match(line, /^\d{4}-\d{2}-\d{2}T.* ERROR Operation failed /);
});

test("overlapping errors retain their own delivery context", async (t) => {
  const output = t.mock.method(console, "error", () => {});
  const gate = Promise.withResolvers();
  const first = withLogContext({ deliveryId: "first" }, async () => {
    await gate.promise;
    logger.error("first finished");
  });
  await withLogContext({ deliveryId: "second" }, async () => {
    await Promise.resolve();
    logger.error("second finished");
  });
  gate.resolve();
  await first;
  const lines = output.mock.calls.map(call => call.arguments[0]);
  assert.match(lines[0], /second finished .*"deliveryId":"second"/);
  assert.match(lines[1], /first finished .*"deliveryId":"first"/);
});

test("worker output shows initial and follow-up prompts with role labels", async (t) => {
  const output = t.mock.method(console, "info", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const worker = new Worker("codex", undefined, "tester");
  t.mock.method(worker, "runCodexTurn", async () => 0);
  await worker.spawn("PRIVATE_PROMPT");
  t.mock.method(worker, "runCodexTurn", async () => { throw new Error("model unavailable"); });
  await assert.rejects(worker.send("PRIVATE_FOLLOWUP"), /model unavailable/);
  const lines = [...output.mock.calls, ...errors.mock.calls].map(call => call.arguments[0]).join("\n");
  for (const event of ["Working", "Idle", "Agent turn failed"]) assert.ok(lines.includes(event));
  assert.ok(lines.includes(worker.workerId.slice(0, 8)));
  assert.ok(lines.includes('[TESTER codex'));
  for (const noise of ['Agent turn queued', 'Agent turn started', 'Agent turn completed', 'still running']) assert.ok(!lines.includes(noise));
  assert.ok(lines.includes("PROMPT (queued): PRIVATE_PROMPT"));
  assert.ok(lines.includes("PROMPT (queued): PRIVATE_FOLLOWUP"));
});
