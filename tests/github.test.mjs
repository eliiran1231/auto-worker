import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getWorkerEnvironment } from "../utils/github.ts";
import { Coder } from "../agents/Coder.ts";
import { Reviewer } from "../agents/Reviewer.ts";
import { Tester } from "../agents/Tester.ts";

const originalEnvironment = { ...process.env };
after(() => { process.env = originalEnvironment; });

test("each worker selects its own credentials without changing the parent environment", () => {
  process.env.CODER_GITHUB_TOKEN = "coder-test-token";
  process.env.REVIEWER_GITHUB_TOKEN = "reviewer-test-token";
  process.env.TESTER_GITHUB_TOKEN = "tester-test-token";
  process.env.GH_TOKEN = "inherited-account";
  process.env.GITHUB_TOKEN = "legacy-account";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "test.existing";
  process.env.GIT_CONFIG_VALUE_0 = "preserved";
  const before = { ...process.env };

  for (const worker of [new Coder("codex"), new Reviewer("claude"), new Tester("codex")]) {
    const env = getWorkerEnvironment(worker.role);
    const token = `${worker.role}-test-token`;
    assert.equal(env.GH_TOKEN, token);
    assert.equal(env.GITHUB_TOKEN, token);
    assert.equal(env.PATH, process.env.PATH);
    for (const role of ["CODER", "REVIEWER", "TESTER"]) {
      assert.equal(env[`${role}_GITHUB_TOKEN`], undefined);
    }
    assert.equal(env.GIT_CONFIG_COUNT, "3");
    assert.equal(env.GIT_CONFIG_VALUE_0, "preserved");
    assert.equal(env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_1, "");
    assert.equal(env.GIT_CONFIG_KEY_2, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_2, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
  }
  assert.deepEqual({ ...process.env }, before);
});

test("missing role credentials fail instead of falling back to a different account", () => {
  for (const role of ["coder", "reviewer", "tester"]) {
    const name = `${role.toUpperCase()}_GITHUB_TOKEN`;
    const previous = process.env[name];
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      assert.throws(() => getWorkerEnvironment(role), { message: `Set ${name} in .env` });
    }
    process.env[name] = previous;
  }
});

test("invalid inherited Git configuration fails clearly", () => {
  process.env.GIT_CONFIG_COUNT = "invalid";
  assert.throws(() => getWorkerEnvironment("coder"), /GIT_CONFIG_COUNT/);
});
