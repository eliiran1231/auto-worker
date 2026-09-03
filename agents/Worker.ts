import {
  query as queryClaude,
  type Query as ClaudeQuery,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Thread as CodexThread } from "@openai/codex-sdk";

export type WorkerType = "codex" | "claude";

export class Worker {
  initialized = false;
  readonly type: WorkerType;
  root?: string;
  conversationId?: string;

  private readonly codex = new Codex();
  private codexThread: CodexThread | null = null;
  private claudeQuery: ClaudeQuery | null = null;
  private abortController: AbortController | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private generation = 0;

  constructor(type: WorkerType, root?: string) {
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
  }

  private enqueueTurn(prompt: string, generation: number): Promise<number> {
    const turn = this.turnQueue.then(async () => {
      if (this.stopped || generation !== this.generation) {
        throw new Error("Worker has been stopped");
      }

      return this.type === "codex"
        ? this.runCodexTurn(prompt, generation)
        : this.runClaudeTurn(prompt, generation);
    });

    // Keep the queue usable after a failed turn while preserving the failure for
    // the caller awaiting this particular turn.
    this.turnQueue = turn.then(
      () => undefined,
      () => undefined,
    );

    return turn;
  }

  private async runCodexTurn(
    prompt: string,
    generation: number,
  ): Promise<number> {
    this.codexThread ??= this.codex.startThread({
      ...(this.root ? { workingDirectory: this.root } : {}),
    });
    const codexThread = this.codexThread;

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      await codexThread.run(prompt, {
        signal: abortController.signal,
      });

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

    const claudeQuery = queryClaude({
      prompt,
      options: {
        abortController,
        ...(this.root ? { cwd: this.root } : {}),
        ...(this.conversationId ? { resume: this.conversationId } : {}),
      },
    });
    this.claudeQuery = claudeQuery;

    let result: SDKResultMessage | undefined;

    try {
      for await (const message of claudeQuery) {
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

    return 0;
  }
}
