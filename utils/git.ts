import { simpleGit } from "simple-git";
import type { WorkerRole } from "../types/WorkerRole.js";
import { getGitEnvironment } from "./github.js";

export function createRoleGit(workspace: string, role: WorkerRole) {
  return simpleGit({
    baseDir: workspace,
    unsafe: { allowUnsafeConfigEnvCount: true },
  }).env(getGitEnvironment(role));
}
