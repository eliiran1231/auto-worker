import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Orchestrator } from "../agents/Orchestrator.ts";
import { settings } from "../settings.ts";

test("clones stay inside the ignored playground", async (t) => {
  const original = process.env.CODER_GITHUB_TOKEN;
  process.env.CODER_GITHUB_TOKEN = "local-test-token";
  t.after(() => { if (original === undefined) delete process.env.CODER_GITHUB_TOKEN; else process.env.CODER_GITHUB_TOKEN = original; });
  const name = `test-${randomUUID()}`;
  const source = path.resolve(settings.workspace.playgroundDirectory, `${name}-source`);
  const destination = path.resolve(settings.workspace.playgroundDirectory, name);
  await mkdir(source, { recursive: true });
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); });
  execFileSync("git", ["init", source]);
  const orchestrator = new Orchestrator();
  assert.equal(await orchestrator.setupWorkspace(name, { clone_url: source }, "coder"), destination);
  assert.equal(execFileSync("git", ["-C", destination, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(), "true");
  assert.doesNotThrow(() => execFileSync("git", ["check-ignore", "-q", destination]));
  await writeFile(path.join(destination, "unfinished-work.txt"), "keep my work");
  const nextPaths = await Promise.all([
    orchestrator.setupWorkspace(name, { clone_url: source }, "coder"),
    orchestrator.setupWorkspace(name, { clone_url: source }, "coder"),
  ]);
  t.after(async () => {
    for (const clone of nextPaths) await rm(clone, { recursive: true, force: true });
  });
  assert.notEqual(nextPaths[0], nextPaths[1]);
  for (const clone of nextPaths) {
    assert.ok(clone.startsWith(`${destination}-`));
    assert.equal(execFileSync("git", ["-C", clone, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(), "true");
    await orchestrator.deleteManagedWorkspace(clone);
  }
  assert.equal(await readFile(path.join(destination, "unfinished-work.txt"), "utf8"), "keep my work");
  await assert.rejects(orchestrator.setupWorkspace("../escape", { clone_url: source }, "coder"), /Invalid playground workspace name/);
});
