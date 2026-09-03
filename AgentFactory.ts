import { Worker } from "./agents/Worker.js";
import { settings } from "./settings.js";
import type { AgentId } from "./types/AgentId.js";

export class AgentFactory {
  static workers: Record<string, Worker> = {};
  static reviewers: Record<string, Worker> = {};

  static registerWorker(issueId: AgentId, worker: Worker): void {
    AgentFactory.workers[issueId] = worker;
  }

  static getWorker(issueId: AgentId): Worker | undefined {
    return AgentFactory.workers[issueId];
  }

  static registerReviewer(prId: AgentId, reviewer: Worker): void {
    AgentFactory.reviewers[prId] = reviewer;
  }

  static getReviewer(prId: AgentId): Worker | undefined {
    return AgentFactory.reviewers[prId];
  }

  static createWorker(issueId: AgentId, rootPath?: string): Worker {
    const worker = new Worker(
      settings.agents.workerType,
      rootPath ?? settings.workspace.defaultRoot,
    );
    this.registerWorker(issueId, worker);
    return worker;
  }

  static createReviewer(prId: AgentId, rootPath?: string): Worker {
    const reviewer = new Worker(
      settings.agents.reviewerType,
      rootPath ?? settings.workspace.defaultRoot,
    );
    this.registerReviewer(prId, reviewer);
    return reviewer;
  }

  static deleteWorker(issueId: AgentId): void {
    delete AgentFactory.workers[String(issueId)];
  }

  static deleteReviewer(prId: AgentId): void {
    delete AgentFactory.reviewers[String(prId)];
  }
}
