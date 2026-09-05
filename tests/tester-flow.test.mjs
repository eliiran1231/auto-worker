import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentFactory } from "../AgentFactory.ts";
import { Orchestrator } from "../agents/Orchestrator.ts";
import { Tester } from "../agents/Tester.ts";
import { WorkflowManager } from "../classes/workflowManager.ts";
import { settings } from "../settings.ts";

const repository = (id) => ({ id, name: "same-name", owner: { login: "repo-owner" }, clone_url: "unused" });

test("completion received during dispatch is replayed and unsubscribed", async (t) => {
  const tester = new Tester("codex");
  const repo = repository(101);
  const run = { id: 41, url: "https://api.github.com/run/41" };
  t.mock.method(tester, "triggerTestWorkflow", async () => {
    WorkflowManager.notifyWorkflowRunCompleted(repo, run);
    return run.id;
  });
  assert.equal(await tester.runTest(repo, "differential.yml", "branch"), run);
  assert.equal(WorkflowManager.getWorkflowRunCompletedReplaySubject(repo).observers.length, 0);
});

test("completion waiting ignores other repositories and run IDs", async () => {
  const repo = repository(102);
  const subject = WorkflowManager.getWorkflowRunCompletedReplaySubject(repo);
  const pending = new Tester("codex").waitForWorkflowCompletion(repo, 42);
  WorkflowManager.notifyWorkflowRunCompleted(repository(103), { id: 42 });
  WorkflowManager.notifyWorkflowRunCompleted(repo, { id: 43 });
  assert.equal(subject.observers.length, 1);
  const run = { id: 42 };
  WorkflowManager.notifyWorkflowRunCompleted(repo, run);
  assert.equal(await pending, run);
  assert.equal(subject.observers.length, 0);
});

test("a missing completion times out and unsubscribes", async () => {
  const previous = settings.tests.workflowTimeoutMs;
  settings.tests.workflowTimeoutMs = 10;
  const repo = repository(104);
  try {
    await assert.rejects(new Tester("codex").waitForWorkflowCompletion(repo, 44), { name: "TimeoutError" });
    assert.equal(WorkflowManager.getWorkflowRunCompletedReplaySubject(repo).observers.length, 0);
  } finally { settings.tests.workflowTimeoutMs = previous; }
});

test("tests are pushed before dispatch, analysis resumes the worker, and cleanup always runs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-worker-flow-"));
  const root = path.join(directory, "working");
  const remote = path.join(directory, "remote.git");
  const originalEnv = { ...process.env };
  process.env.CODER_GITHUB_TOKEN = "test-coder";
  process.env.TESTER_GITHUB_TOKEN = "test-tester";
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(root);
    git("init");
    git("config", "user.name", "Test Worker");
    git("config", "user.email", "worker@example.test");
    git("commit", "--allow-empty", "-m", "initial");
    git("init", "--bare", remote);
    git("remote", "add", "origin", remote);
    const repo = repository(105);
    const tester = new Tester("codex", root);
    const turns = [];
    t.mock.method(tester, "runCodexTurn", async (prompt) => {
      turns.push(prompt);
      if (prompt === settings.prompts.writeTests || prompt === settings.prompts.continueWritingTests) {
        assert.match(git("branch", "--show-current"), /^farm\/tests-/);
        await writeFile(path.join(root, "regression.test.txt"), "regression\n" + turns.length);
        git("add", ".");
        git("commit", "-m", "tests " + turns.length);
      }
      return 0;
    });
    t.mock.method(tester, "runTest", async (actualRepo, workflowId, branch) => {
      assert.equal(actualRepo, repo);
      assert.equal(workflowId, "differential.yml");
      assert.match(branch, /^farm\/tests-\d+$/);
      assert.equal(git("--git-dir", remote, "show", `${branch}:regression.test.txt`), "regression\n" + turns.length);
      assert.equal(tester.initialized, true);
      return { id: 45, url: "https://api.github.com/run/45", conclusion: turns.length === 1 ? "success" : "failure" };
    });
    const orchestrator = new Orchestrator();
    t.mock.method(orchestrator, "setupWorkspace", async () => root);
    t.mock.method(AgentFactory, "createTester", () => tester);
    const release = t.mock.method(orchestrator, "releaseTester", async (id) => {
      assert.equal(id, repo.id);
      tester.kill();
    });
    assert.match(await orchestrator.spawnATesterToFindBugs(repo), /^farm\/tests-/);
    assert.equal(turns.length, 3);
    assert.match(turns[2], /https:\/\/api.github.com\/run\/45/);
    assert.equal(release.mock.callCount(), 1);
    // Unexpected workflow conclusions fail and still clean up.
    t.mock.method(tester, "runTest", async () => ({ conclusion: "cancelled" }));
    await assert.rejects(orchestrator.spawnATesterToFindBugs(repo));
    assert.equal(release.mock.callCount(), 2);
  } finally {
    process.env = originalEnv;
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
