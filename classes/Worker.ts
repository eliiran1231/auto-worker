import {
  query as queryClaude,
  type Query as ClaudeQuery,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Thread as CodexThread } from "@openai/codex-sdk";
import type { WorkerRole } from "../types/WorkerRole.js";
import { getWorkerEnvironment } from "../utils/github.js";
import { randomUUID } from "node:crypto";
import { logger, withLogContext } from "../utils/logger.js";

export type WorkerType = "codex" | "claude";
export type WorkerStatus = "idle" | "working" | "error";

export class Worker {
  readonly workerId = randomUUID();
  initialized = false;
  readonly type: WorkerType;
  status: WorkerStatus = "idle";
  root?: string;
  conversationId?: string;

  private codex: Codex | null = null;
  private readonly queryClaude = queryClaude;
  private codexThread: CodexThread | null = null;
  private claudeQuery: ClaudeQuery | null = null;
  private abortController: AbortController | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private generation = 0;
  private pendingTurns = 0;

  constructor(type: WorkerType, root: string | undefined, readonly role: WorkerRole) {
    this.type = type;
    this.root = root;
  }

  spawn(prompt: string, repoPath = this.root): Promise<number> {
    if (this.initialized) {
      throw new Error("Worker already initialized");
    }

    this.root = repoPath;
    this.conversationId = undefined;
    this.codexThread = null;
    this.initialized = true;
    this.stopped = false;
    this.generation += 1;
    this.pendingTurns = 0;

    return this.enqueueTurn(prompt, this.generation);
  }

  send(message: string): Promise<number> {
    if (!this.initialized) {
      throw new Error("Worker not initialized");
    }

    return this.enqueueTurn(message, this.generation);
  }

  kill(): void {

    this.stopped = true;
    this.abortController?.abort();
    this.claudeQuery?.close();

    this.abortController = null;
    this.claudeQuery = null;
    this.codexThread = null;
    this.initialized = false;
    this.generation += 1;
    this.pendingTurns = 0;
    this.status = "idle";
  }

  private enqueueTurn(prompt: string, generation: number): Promise<number> {
    const queuedAt = Date.now();
    const fields = { workerId: this.workerId, role: this.role, engine: this.type, workspace: this.root };
    this.pendingTurns += 1;
    this.status = "working";
    this.say(`PROMPT (queued): ${prompt}`);

    const turn = this.turnQueue.then(async () => {
      if (this.stopped || generation !== this.generation) {
        throw new Error("Worker has been stopped");
      }

      this.say("▶ Working");
      return withLogContext(fields, () => this.type === "codex"
        ? this.runCodexTurn(prompt, generation)
        : this.runClaudeTurn(prompt, generation));
    });

    const trackedTurn = turn.then(
      (result) => {
        this.finishTurn(generation, false);
        this.say(this.status === "working" ? "✓ Turn finished; more work queued" : "✓ Idle — turn finished");

        return result;
      },
      (error: unknown) => {
        this.finishTurn(generation, true);
        this.say("✗ Turn failed (see error below)");
        logger.error("Agent turn failed", { ...fields, durationMs: Date.now() - queuedAt, error });
        throw error;
      },
    );

    // Keep the queue usable after a failed turn while preserving the failure for
    // the caller awaiting this particular turn.
    this.turnQueue = trackedTurn.then(
      () => undefined,
      () => undefined,
    );

    return trackedTurn;
  }

  private finishTurn(generation: number, failed: boolean): void {
    if (generation !== this.generation) return;

    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    if (this.pendingTurns > 0) {
      this.status = "working";
      return;
    }

    this.status = failed ? "error" : "idle";
  }

  private say(message: string): void {
    logger.agent(this.role, this.type, this.workerId, message);
  }

  private async runCodexTurn(
    prompt: string,
    generation: number,
  ): Promise<number> {
    this.codex ??= new Codex({ env: getWorkerEnvironment(this.role) });
    this.codexThread ??= this.codex.startThread({
      ...(this.root ? { workingDirectory: this.root } : {}),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never"
    });
    const codexThread = this.codexThread;

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const { events } = await codexThread.runStreamed(prompt, {
        signal: abortController.signal,
      });
      let completed = false;
      for await (const event of events) {
        if (generation !== this.generation) throw new Error("Worker has been stopped");
        if (event.type === "thread.started") this.conversationId = event.thread_id;
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          this.say(event.item.text);
        }
        if (event.type === "item.started") {
          if (event.item.type === "command_execution") this.say(`Running command: ${event.item.command}`);
          if (event.item.type === "mcp_tool_call") this.say(`Using tool: ${event.item.server}/${event.item.tool}`);
          if (event.item.type === "web_search") this.say("Searching the web");
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "turn.completed") completed = true;
      }
      if (!completed) throw new Error("Codex worker ended without a completed turn");

      if (generation !== this.generation) {
        throw new Error("Worker has been stopped");
      }

      this.conversationId = codexThread.id ?? undefined;
      return 0;
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  private async runClaudeTurn(
    prompt: string,
    generation: number,
  ): Promise<number> {
    const abortController = new AbortController();
    this.abortController = abortController;

    const claudeQuery = this.queryClaude({
      prompt,
      options: {
        env: getWorkerEnvironment(this.role),
        abortController,
        ...(this.root ? { cwd: this.root } : {}),
        ...(this.conversationId ? { resume: this.conversationId } : {}),
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
      },
    });
    this.claudeQuery = claudeQuery;

    let result: SDKResultMessage | undefined;
    let lastText: string | undefined;

    try {
      for await (const message of claudeQuery) {
        if (generation !== this.generation) throw new Error("Worker has been stopped");
        if (
          generation === this.generation &&
          "session_id" in message &&
          message.session_id
        ) {
          this.conversationId = message.session_id;
        }

        if (message.type === "result") {
          result = message;
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              this.say(block.text);
              lastText = block.text;
            }
            if (block.type === "tool_use") this.say(`Using tool: ${block.name}`);
          }
        }
      }
    } finally {
      if (this.claudeQuery === claudeQuery) {
        this.claudeQuery = null;
      }
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }

    if (!result) {
      throw new Error("Claude worker ended without a result");
    }

    if (generation !== this.generation) {
      throw new Error("Worker has been stopped");
    }

    if (result.subtype !== "success" || result.is_error) {
      const details =
        result.subtype === "success"
          ? result.result
          : result.errors.join("; ");
      throw new Error(details || `Claude worker failed: ${result.subtype}`);
    }

    if (result.result && result.result !== lastText) this.say(result.result);

    return 0;
  }
}
