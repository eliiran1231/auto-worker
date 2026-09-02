import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import type { AgentId } from "../types/AgentId.js";

export class Worker {
  initialized = false;
  type: string;
  root: string;
  workerProcess: ChildProcess | null = null;
  issueId?: AgentId;
  prId?: AgentId;

  constructor(type: string, root = "c:/") {
    this.type = type;
    this.root = root;
  }

  spawn(prompt: string, repoPath = this.root): Promise<number> {
    this.root = repoPath;
    if (this.initialized) {
      throw new Error("Worker already initialized");
    }

    return new Promise((resolve, reject) => {
      this.workerProcess = spawnProcess(this.type, ["run", prompt], {
        cwd: this.root,
        shell: true,
      });

      this.workerProcess.on("close", (code) => {
        if (code === 0) {
          resolve(code);
        } else {
          reject(code);
        }
      });
    });
  }

  kill(): void {
    this.workerProcess?.kill();
    this.workerProcess = null;
  }
}
