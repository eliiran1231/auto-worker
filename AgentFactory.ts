import { Coder } from "./agents/Coder.js";
import { Reviewer } from "./agents/Reviewer.js";
import { Worker } from "./classes/Worker.js";
import { settings } from "./settings.js";
import type { AgentId } from "./types/AgentId.js";

export class AgentFactory {
  static coders: Record<string, Coder> = {};
  static reviewers: Record<string, Reviewer> = {};

  static registerCoder(issueId: AgentId, coder: Coder): void {
    AgentFactory.coders[issueId] = coder;
  }

  static getCoder(issueId: AgentId): Coder | undefined {
    return AgentFactory.coders[issueId];
  }

  static registerReviewer(prId: AgentId, reviewer: Reviewer): void {
    AgentFactory.reviewers[prId] = reviewer;
  }

  static getReviewer(prId: AgentId): Reviewer | undefined {
    return AgentFactory.reviewers[prId];
  }

  static createCoder(issueId: AgentId, rootPath?: string): Coder {
    const coder = new Coder(
      settings.agents.workerType,
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

  static deleteCoder(issueId: AgentId): void {
    delete AgentFactory.coders[String(issueId)];
  }

  static deleteReviewer(prId: AgentId): void {
    delete AgentFactory.reviewers[String(prId)];
  }
}
