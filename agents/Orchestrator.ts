import path from "node:path";
import { Octokit } from "octokit";
import { simpleGit } from "simple-git";
import { AgentFactory } from "../AgentFactory.js";
import type { LinkedIssue } from "../interfaces/LinkedIssue.js";
import type { LinkedIssuesResponse } from "../interfaces/LinkedIssuesResponse.js";
import type { Repository } from "../interfaces/Repository.js";
import type { WorkItem } from "../interfaces/WorkItem.js";
import { settings } from "../settings.js";
import type { AgentId } from "../types/AgentId.js";
import type { IssueAssignedEvent } from "../types/IssueAssignedEvent.js";
import type { PullRequestClosedEvent } from "../types/PullRequestClosedEvent.js";
import type { PullRequestReviewEvent } from "../types/PullRequestReviewEvent.js";
import type { PullRequestReviewRequestEvent } from "../types/PullRequestReviewRequestEvent.js";
import { ClosedPullRequest, PullRequest } from "../types/PullRequest.js";

export class Orchestrator {
  private readonly git = simpleGit();
  private readonly octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });
  private readonly linkedIssuesMap = new Map<string, LinkedIssue[]>();

  async getLinkedIssues(
    pr: number,
    repo: string,
    owner: string,
  ): Promise<LinkedIssue[]> {
    const cacheKey = this.linkedIssuesCacheKey(owner, repo, pr);
    const cachedIssues = this.linkedIssuesMap.get(cacheKey);
    if (cachedIssues) return cachedIssues;

    const { repository } = await this.octokit.graphql<LinkedIssuesResponse>(
      settings.queries.linkedIssues,
      {
        owner,
        repo,
        pr,
        limit: settings.github.linkedIssuesLimit,
      },
    );

    const issues = repository.pullRequest.closingIssuesReferences.nodes;
    this.linkedIssuesMap.set(cacheKey, issues);
    return issues;
  }

  async setupWorkspace(
    issue: WorkItem,
    repository: Repository,
  ): Promise<string> {
    const clonedRepoPath = this.formatTemplate(
      settings.workspace.issueDirectoryTemplate,
      {
        repositoryPrefix: repository.name.slice(
          0,
          settings.workspace.repositoryPrefixLength,
        ),
        issueNumber: issue.number,
      },
    );
    await this.git.clone(repository.clone_url, clonedRepoPath);
    return path.resolve(clonedRepoPath);
  }

  async spawnWorkerToResolveIssue(issue : any, repository: Repository): Promise<void> {
    if (issue.assignee?.login !== settings.github.username) {
      return;
    }

    const repoPath = await this.setupWorkspace(
      issue,
      repository,
    );
    const worker = AgentFactory.createWorker(issue.id, repoPath);
    await worker.spawn(
      this.formatTemplate(settings.prompts.workOnIssue, {
        issueNumber: issue.number,
      }),
    );
  }

  async spawnReviewerForPR(pullRequest: PullRequest): Promise<void> {
    if (
      pullRequest.assignee?.login !== settings.github.username ||
      pullRequest.draft
    ) {
      return;
    }

    const reviewer = AgentFactory.createReviewer(pullRequest.id);
    await reviewer.spawn(
      this.formatTemplate(settings.prompts.reviewPullRequest, {
        pullRequestUrl: pullRequest.url,
      }),
    );
  }

  tellReviewerToReReviewPR(pullRequest: PullRequest): void {
    if (
      pullRequest.assignee?.login !== settings.github.username ||
      pullRequest.draft
    ) {
      return;
    }

    const reviewer = AgentFactory.getReviewer(pullRequest.id);
    reviewer?.send(
      this.formatTemplate(settings.prompts.reReviewPullRequest, {
        pullRequestUrl: pullRequest.url,
      }),
    );
  }

  async tellAssignedWorkerToAddressReview(pullRequest: PullRequest): Promise<void> {
    const repo = pullRequest.base.repo.name;
    const owner = pullRequest.base.repo.owner!.login;
    const linkedIssues = await this.getLinkedIssues(
      pullRequest.number,
      repo,
      owner,
    );

    if (linkedIssues.length !== 1) {
      throw new Error(
        `Expected exactly one linked issue for ${owner}/${repo}#${pullRequest.number}, found ${linkedIssues.length}`,
      );
    }

    const worker = AgentFactory.getWorker(linkedIssues[0].id);
    await worker?.send(
      this.formatTemplate(settings.prompts.addressReview, {
        pullRequestUrl: pullRequest.url,
      }),
    );
  }

  async mergePullRequest(pullRequest: PullRequest): Promise<any> {
    const { data } = await this.octokit.rest.pulls.merge({
      owner: pullRequest.base.repo.owner!.login,
      repo: pullRequest.base.repo.name,
      pull_number: pullRequest.number,
    });
    return data;
  }

  releaseWorker(issueId: AgentId): void {
    const worker = AgentFactory.getWorker(issueId);
    worker?.kill();
    AgentFactory.deleteWorker(issueId);
  }

  releaseReviewer(prId: AgentId): void {
    const reviewer = AgentFactory.getReviewer(prId);
    reviewer?.kill();
    AgentFactory.deleteReviewer(prId);
  }

  async iterationCleanup(pullRequest: PullRequest): Promise<void> {
    const repo = pullRequest.base.repo.name;
    const owner = pullRequest.base.repo.owner!.login;
    const linkedIssues = await this.getLinkedIssues(
      pullRequest.number,
      repo,
      owner,
    );

    this.linkedIssuesMap.delete(
      this.linkedIssuesCacheKey(owner, repo, pullRequest.number),
    );
    linkedIssues.forEach((issue) => this.releaseWorker(issue.id));
    this.releaseReviewer(pullRequest.id);
  }

  private linkedIssuesCacheKey(
    owner: string,
    repo: string,
    pr: number,
  ): string {
    return `${owner}/${repo}#${pr}`;
  }

  private formatTemplate(
    template: string,
    values: Record<string, string | number>,
  ): string {
    return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
      key in values ? String(values[key]) : placeholder,
    );
  }
}
