import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhooks } from "@octokit/webhooks";
import { registerWebhooks } from "../utils/registerWebhooks.ts";
import { Orchestrator } from "../agents/Orchestrator.ts";
import { WorkflowManager } from "../classes/workflowManager.ts";
import { createRoleGit } from "../utils/git.ts";
import { settings } from "../settings.ts";

const repo = (id) => ({ id, name: "same", owner: { login: "owner" } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function orchestrator(t) {
  const old = process.env.CODER_GITHUB_TOKEN;
  process.env.CODER_GITHUB_TOKEN = "coder-test";
  t.after(() => { if (old === undefined) delete process.env.CODER_GITHUB_TOKEN; else process.env.CODER_GITHUB_TOKEN = old; });
  return new Orchestrator();
}

test("all agent webhook routes return before the work completes and log rejection", async (t) => {
  const pr = { id: 999, assignee: { login: settings.github.username }, draft: false, state: "open", merged: true };
  for (const [name, action, method, extra] of [
    ["issues", "assigned", "spawnWorkerToResolveIssue", { issue: {} }],
    ["pull_request", "opened", "spawnReviewerForPR", {}],
    ["pull_request", "synchronize", "spawnReviewerForPR", {}],
    ["pull_request_review", "submitted", "mergePullRequest", { review: { state: "approved" } }],
    ["pull_request_review", "submitted", "tellAssignedWorkerToAddressReview", { review: { state: "changes_requested" } }],
    ["pull_request", "closed", "iterationCleanup", {}],
  ]) {
    const deferred = Promise.withResolvers();
    const calls = [];
    const worker = { [method]: () => { calls.push(method); return deferred.promise; } };
    const log = t.mock.method(console, "error", () => {});
    const hooks = new Webhooks({ secret: "test" });
    registerWebhooks(hooks, worker);
    let received = false;
    const receipt = hooks.receive({ id: "delivery", name, payload: { action, pull_request: pr, repository: repo(1), ...extra } }).then(() => { received = true; });
    await tick();
    assert.equal(received, true, `${name}.${action} must not wait for agent work`);
    assert.deepEqual(calls, [method]);
    deferred.reject(new Error("worker failed"));
    await receipt;
    await tick();
    assert.equal(log.mock.callCount(), 1);
    assert.match(log.mock.calls[0].arguments[0], /delivery/);
    log.mock.restore();
  }
});

test("PR close cleans up before scheduling its scan in the background", async () => {
  const gate = Promise.withResolvers();
  const calls = [];
  const hooks = new Webhooks({ secret: "test" });
  registerWebhooks(hooks, {
    iterationCleanup: () => { calls.push("cleanup"); return gate.promise; },
    spawnATesterToFindBugs: async () => { calls.push("scan"); },
  });
  await hooks.receive({ id: "close", name: "pull_request", payload: { action: "closed", pull_request: { merged: true }, repository: repo(1) } });
  assert.deepEqual(calls, ["cleanup"]);
  gate.resolve();
  await tick();
  assert.deepEqual(calls, ["cleanup", "scan"]);
});

test("linked branch lookup retries empty and null refs, using the issue number", async (t) => {
  const worker = orchestrator(t);
  const previous = settings.github.linkedBranchRetryMs;
  settings.github.linkedBranchRetryMs = 1;
  t.after(() => { settings.github.linkedBranchRetryMs = previous; });
  const responses = [[], [{ ref: null }], [{ ref: { name: "tester/branch" } }]];
  const lookup = t.mock.method(worker, "getLinkedBranches", async (number) => {
    assert.equal(number, 17);
    return responses.shift();
  });
  assert.equal(await worker.waitForLinkedBranch({ id: 987, number: 17 }, repo(1)), "tester/branch");
  assert.equal(lookup.mock.callCount(), 3);
  t.mock.method(worker, "getLinkedBranches", async () => []);
  await assert.rejects(worker.waitForLinkedBranch({ number: 17 }, repo(1)), /exactly one linked branch/);
  const multiple = t.mock.method(worker, "getLinkedBranches", async () => [{ ref: { name: "a" } }, { ref: { name: "b" } }]);
  await assert.rejects(worker.waitForLinkedBranch({ number: 17 }, repo(1)), /exactly one linked branch/);
  assert.equal(multiple.mock.callCount(), 1);
});

test("role Git instances pass isolated credentials to subsequent Git commands", async (t) => {
  const before = { ...process.env };
  t.after(() => { process.env = before; });
  for (const role of ["coder", "tester"]) process.env[`${role.toUpperCase()}_GITHUB_TOKEN`] = `${role}-test`;
  const clients = ["coder", "tester"].map(role => createRoleGit(process.cwd(), role));
  const values = await Promise.all(clients.map(git => git.raw(["config", "--get-urlmatch", "http.extraheader", "https://github.com/example/repo"])));
  for (const [i, role] of ["coder", "tester"].entries()) {
    assert.equal(values[i].trim(), `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${role}-test`).toString("base64")}`);
  }
});

test("completion replay is bounded by count and age", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const repository = repo(800);
  const subject = WorkflowManager.getWorkflowRunCompletedReplaySubject(repository);
  for (let id = 0; id < settings.tests.completionReplayLimit + 5; id++) WorkflowManager.notifyWorkflowRunCompleted(repository, { id });
  const replay = [];
  subject.subscribe(run => replay.push(run.id)).unsubscribe();
  assert.equal(replay.length, settings.tests.completionReplayLimit);
  assert.equal(replay[0], 5);
  now += settings.tests.completionReplayMs + 1;
  const expired = [];
  subject.subscribe(run => expired.push(run)).unsubscribe();
  assert.deepEqual(expired, []);
});

test("same-repository merges coalesce into one fresh scan while other repositories proceed", async (t) => {
  const worker = orchestrator(t);
  const gates = [];
  t.mock.method(worker, "runTesterScan", async (repository) => {
    const gate = Promise.withResolvers();
    gates.push({ id: repository.id, ...gate });
    return gate.promise;
  });
  const first = worker.spawnATesterToFindBugs(repo(1));
  await tick();
  assert.equal(worker.spawnATesterToFindBugs(repo(1)), first);
  assert.equal(worker.spawnATesterToFindBugs(repo(1)), first);
  const other = worker.spawnATesterToFindBugs(repo(2));
  await tick();
  assert.deepEqual(gates.map(g => g.id), [1, 2]);
  gates[0].resolve("first");
  await tick();
  assert.deepEqual(gates.map(g => g.id), [1, 2, 1]);
  gates[2].resolve("fresh");
  gates[1].resolve("other");
  assert.equal(await first, "fresh");
  assert.equal(await other, "other");
  assert.equal(worker.testerScans.size, 0);
});

test("a queued fresh scan still runs after failure and the lock is released", async (t) => {
  const worker = orchestrator(t);
  const gate = Promise.withResolvers();
  let count = 0;
  t.mock.method(worker, "runTesterScan", async () => { if (++count === 1) return gate.promise; return "fresh"; });
  const pending = worker.spawnATesterToFindBugs(repo(3));
  const rejection = assert.rejects(pending, /Tester scan failed/);
  await tick();
  worker.spawnATesterToFindBugs(repo(3));
  gate.reject(new Error("scan failed"));
  await rejection;
  assert.equal(count, 2);
  assert.equal(await worker.spawnATesterToFindBugs(repo(3)), "fresh");
});
