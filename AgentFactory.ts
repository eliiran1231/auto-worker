import { Coder } from "./agents/Coder.js";
import { Reviewer } from "./agents/Reviewer.js";
import { Tester } from "./agents/Tester.js";
import { settings } from "./settings.js";
import type { AgentId } from "./types/AgentId.js";
import { WorkerStore } from "./classes/WorkerStore.js";
import type { Worker } from "./classes/Worker.js";
import type { WorkerRole } from "./types/WorkerRole.js";
import { logger } from "./utils/logger.js";

export class AgentFactory {
  private static store?: WorkerStore;
  static coders: Record<string, Coder> = {};
  static reviewers: Record<string, Reviewer> = {};
  static testers: Record<string, Tester> = {};

  static restoreFrom(store: WorkerStore): void {
    this.store = store;
    for (const saved of store.load()) {
      const worker = saved.role === "coder" ? new Coder(saved.type, saved.root ?? undefined)
        : saved.role === "reviewer" ? new Reviewer(saved.type, saved.root ?? undefined)
        : new Tester(saved.type, saved.root ?? undefined);
      worker.restore(saved, store);
      this.registry(saved.role)[saved.agentId] = worker as never;
    }
  }

  static resumePendingTurns(): void {
    for (const worker of [...Object.values(this.coders), ...Object.values(this.reviewers)]) {
      void worker.resumePendingTurns().catch(error => logger.error("Recovered worker turn failed", { role: worker.role, workerId: worker.workerId, error }));
    }
  }

  private static registry(role: WorkerRole): Record<string, Worker> {
    return role === "coder" ? this.coders : role === "reviewer" ? this.reviewers : this.testers;
  }

  static registerCoder(issueId: AgentId, coder: Coder): void {
    AgentFactory.coders[issueId] = coder;
    this.store && coder.attachStore(this.store, String(issueId));
  }

  static getCoder(issueId: AgentId): Coder | undefined {
    return AgentFactory.coders[issueId];
  }

  static registerReviewer(prId: AgentId, reviewer: Reviewer): void {
    AgentFactory.reviewers[prId] = reviewer;
    this.store && reviewer.attachStore(this.store, String(prId));
  }

  static getReviewer(prId: AgentId): Reviewer | undefined {
    return AgentFactory.reviewers[prId];
  }

  static registerTester(testerId: AgentId, tester: Tester): void {
    AgentFactory.testers[testerId] = tester;
    this.store && tester.attachStore(this.store, String(testerId));
  }

  static getTester(testerId: AgentId): Tester | undefined {
    return AgentFactory.testers[testerId];
  }

  static createCoder(issueId: AgentId, rootPath?: string): Coder {
    const coder = new Coder(
      settings.agents.coderType,
      rootPath ?? settings.workspace.defaultRoot,
    );
    this.registerCoder(issueId, coder);
    return coder;
  }

  static createReviewer(prId: AgentId, rootPath?: string): Reviewer {
    const reviewer = new Reviewer(settings.agents.reviewerType, rootPath);
    this.registerReviewer(prId, reviewer);
    return reviewer;
  }

  static createTester(testerId: AgentId, rootPath?: string): Tester {
    const tester = new Tester(settings.agents.testerType, rootPath);
    this.registerTester(testerId, tester);
    return tester;
  }

  static deleteCoder(issueId: AgentId): void {
    delete AgentFactory.coders[String(issueId)];
    this.store?.delete("coder", String(issueId));
  }

  static deleteReviewer(prId: AgentId): void {
    delete AgentFactory.reviewers[String(prId)];
    this.store?.delete("reviewer", String(prId));
  }

  static deleteTester(testerId: AgentId): void {
    delete AgentFactory.testers[String(testerId)];
    this.store?.delete("tester", String(testerId));
  }
}
