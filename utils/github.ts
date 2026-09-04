import type { WorkerRole } from "../types/WorkerRole.js";

export function getGitHubToken(role: WorkerRole): string {
  const name = `${role.toUpperCase()}_GITHUB_TOKEN`;
  const token = process.env[name]?.trim();
  if (!token) throw new Error(`Set ${name} in .env`);
  return token;
}

export function getWorkerEnvironment(role: WorkerRole): Record<string, string> {
  const token = getGitHubToken(role);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(?:(?:CODER|REVIEWER|TESTER)_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/i.test(key)) {
      env[key] = value;
    }
  }
  // gh prefers GH_TOKEN; set both names so every tool uses this role's account.
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;

  // Authenticate HTTPS Git without persisting a token in the clone URL or config.
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("GIT_CONFIG_COUNT must be a non-negative integer");
  }
  env[`GIT_CONFIG_KEY_${count}`] = "http.https://github.com/.extraheader";
  env[`GIT_CONFIG_VALUE_${count}`] = "";
  env[`GIT_CONFIG_KEY_${count + 1}`] = "http.https://github.com/.extraheader";
  env[`GIT_CONFIG_VALUE_${count + 1}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  env.GIT_CONFIG_COUNT = String(count + 2);
  return env;
}
