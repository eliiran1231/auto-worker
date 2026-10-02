import assert from "node:assert/strict";
import { test } from "node:test";
import nodemailer from "nodemailer";
import { settings, validateEmailSettings } from "../settings.ts";
import { logger, withLogContext } from "../utils/logger.ts";
import { flushFailureEmails, sendTestEmail } from "../utils/failureEmail.ts";
import { Worker } from "../classes/Worker.ts";
import { Orchestrator } from "../agents/Orchestrator.ts";
import { Webhooks } from "@octokit/webhooks";
import { registerWebhooks } from "../utils/registerWebhooks.ts";

function mail(t) {
  const original = settings.email;
  const env = { ...process.env };
  settings.email = { enabled: true, host: "smtp.example.com", port: 587, secure: false,
    from: "worker@example.com", to: "owner@example.com", username: "worker", passwordEnv: "MAIL_CREDENTIAL" };
  process.env.MAIL_CREDENTIAL = "private-mail-credential";
  process.env.CODER_GITHUB_TOKEN = "private-github-token";
  const sent = [];
  const options = [];
  const transport = { async sendMail(message) { sent.push(message); }, close() {} };
  t.mock.method(nodemailer, "createTransport", config => { options.push(config); return transport; });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  t.after(async () => { await flushFailureEmails(); settings.email = original; process.env = env; });
  return { sent, options, transport };
}

test("test email uses saved addresses while alerts are disabled and surfaces sanitized SMTP errors", async t => {
  const { sent, transport } = mail(t);
  settings.email.enabled = false;
  await sendTestEmail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, settings.email.to);
  assert.equal(sent[0].from, settings.email.from);
  assert.match(sent[0].subject, /Test email/);
  assert.equal(settings.email.enabled, false);
  t.mock.method(transport, "sendMail", async () => { throw new Error("private-mail-credential"); });
  await assert.rejects(sendTestEmail(), error => /Email could not be sent/.test(error.message) && !error.message.includes("private-mail-credential"));
});

test("alerts contain redacted stack and context, and propagated errors are deduplicated", async t => {
  const { sent, options } = mail(t);
  const error = new Error("failed private-mail-credential private-github-token", { cause: new Error("underlying cause") });
  withLogContext({ repository: "owner/repo", deliveryId: "delivery-1" }, () => {
    logger.error("Scan stopped", { workerId: "worker-1", error });
    logger.error("Outer catch", { error });
    logger.error("Aggregate catch", { error: new AggregateError([error], "stopped") });
  });
  await flushFailureEmails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.com");
  for (const detail of ["owner/repo", "delivery-1", "worker-1", "stack", "underlying cause", "[REDACTED]"]) assert.ok(sent[0].text.includes(detail));
  assert.ok(!sent[0].text.includes("private-mail-credential"));
  assert.ok(!sent[0].text.includes("private-github-token"));
  assert.equal(options[0].auth.pass, "private-mail-credential");
  assert.equal(options[0].requireTLS, true);
});

test("disabled email does not connect; live settings are used for subsequent alerts", async t => {
  const { sent, options } = mail(t);
  settings.email.enabled = false;
  logger.error("Disabled", { error: new Error("failure") });
  await flushFailureEmails();
  assert.equal(options.length, 0);
  settings.email.enabled = true;
  settings.email.to = "new@example.com";
  logger.error("Enabled", { error: new Error("failure") });
  await flushFailureEmails();
  assert.equal(sent[0].to, "new@example.com");
});

test("nonzero worker returns notify and reject; SMTP failure preserves the original error", async t => {
  const { sent, transport } = mail(t);
  const worker = new Worker("codex", undefined, "coder");
  t.mock.method(worker, "runCodexTurn", async () => 7);
  await assert.rejects(worker.spawn("work"), /failure code 7/);
  await flushFailureEmails();
  assert.equal(worker.status, "error");
  assert.equal(sent.length, 1);
  const original = new Error("SDK unavailable");
  t.mock.method(worker, "runCodexTurn", async () => { throw original; });
  t.mock.method(transport, "sendMail", async () => { throw new Error("SMTP refused private-mail-credential"); });
  await assert.rejects(worker.send("retry"), error => error === original);
  await flushFailureEmails();
  assert.equal(sent.length, 1);
});

test("a stopped scan reports its repository, and a failed merge response rejects", async t => {
  const { sent } = mail(t);
  const orchestrator = new Orchestrator();
  t.mock.method(orchestrator, "runTesterScan", async () => { throw new Error("workflow timed out"); });
  await assert.rejects(orchestrator.spawnATesterToFindBugs({ id: 912, name: "repo", owner: { login: "owner" } }), /Tester scan failed/);
  await flushFailureEmails();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /owner\/repo/);
  t.mock.method(orchestrator.octokit.rest.pulls, "merge", async () => ({ data: { merged: false, message: "Merge conflict" } }));
  await assert.rejects(orchestrator.mergePullRequest({ number: 4, base: { repo: { name: "repo", owner: { login: "owner" } } } }), /Merge conflict/);
});

test("early return after unmerged closure sends an alert but draft filtering does not", async t => {
  const { sent } = mail(t);
  const hooks = new Webhooks({ secret: "test" });
  registerWebhooks(hooks, { iterationCleanup: async () => {} });
  await hooks.receive({ id: "close", name: "pull_request", payload: {
    action: "closed", pull_request: { number: 4, merged: false }, repository: { full_name: "owner/repo" },
  } });
  await new Promise(resolve => setImmediate(resolve));
  await flushFailureEmails();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /closed without merging/);
  await hooks.receive({ id: "draft", name: "pull_request", payload: { action: "synchronize", pull_request: { draft: true } } });
  await new Promise(resolve => setImmediate(resolve));
  await flushFailureEmails();
  assert.equal(sent.length, 1);
});

test("email validation requires usable enabled configuration", t => {
  mail(t);
  assert.doesNotThrow(() => validateEmailSettings(settings.email));
  for (const patch of [{ to: "invalid" }, { port: 0 }, { port: 1.5 }, { host: "" }, { passwordEnv: "MISSING_MAIL_PASSWORD" }]) {
    assert.throws(() => validateEmailSettings({ ...settings.email, ...patch }));
  }
  assert.doesNotThrow(() => validateEmailSettings({ ...settings.email, enabled: false, host: "", to: "" }));
});
