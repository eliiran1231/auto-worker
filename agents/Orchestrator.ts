import { rm } from "node:fs/promises";
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
import type { PullRequest } from "../types/PullRequest.js";
import { formatTemplate } from "../utils/templates.js";

export class Orchestrator {
  private readonly git = simpleGit();
  private readonly octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });
  private readonly linkedIssuesMap = new Map<string, LinkedIssue[]>();
  private readonly managedWorkspaces = new Set<string>();

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
    clonedRepoPath: string,
    repository: Repository,
  ): Promise<string> {
    const workspacePath = path.resolve(clonedRepoPath);
    await this.git.clone(repository.clone_url, workspacePath);
    this.managedWorkspaces.add(workspacePath);
    return workspacePath;
  }

  async spawnWorkerToResolveIssue(issue : any, repository: Repository): Promise<void> {
    if (issue.assignee?.login !== settings.github.username) {
      return;
    }
    const repoPath = formatTemplate(
      settings.workspace.issueDirectoryTemplate,
      {
        repositoryPrefix: repository.name.slice(
          0,
          settings.workspace.repositoryPrefixLength,
        ),
        issueNumber: issue.number,
      },
    );
    const workspacePath = await this.setupWorkspace(
      repoPath,
      repository,
    );
    const coder = AgentFactory.createCoder(issue.id, workspacePath);
    await coder.solveIssue(issue);
  }

  async spawnReviewerForPR(pullRequest: PullRequest): Promise<void> {
    if (
      pullRequest.assignee?.login !== settings.github.username ||
      pullRequest.draft
    ) {
      return;
    }

    const reviewer = AgentFactory.createReviewer(pullRequest.id);
    await reviewer.reviewPullRequest(pullRequest);
  }

  async tellReviewerToReReviewPR(pullRequest: PullRequest) {
    if (
      pullRequest.assignee?.login !== settings.github.username ||
      pullRequest.draft
    ) return;

    const reviewer = AgentFactory.getReviewer(pullRequest.id);
    if (!reviewer) throw new Error(
        `No reviewer found for ${pullRequest.base.repo.owner!.login}/${pullRequest.base.repo.name}#${pullRequest.number}`,
      );
    return reviewer.reReviewPullRequest(pullRequest);
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

    const coder = AgentFactory.getCoder(linkedIssues[0].id);
    if (!coder) throw new Error (
      `No coder found for linked issue ${linkedIssues[0].id} of ${owner}/${repo}#${pullRequest.number}`,
    );
    await coder.addressReview(pullRequest);
  }

  async mergePullRequest(pullRequest: PullRequest): Promise<any> {
    const { data } = await this.octokit.rest.pulls.merge({
      owner: pullRequest.base.repo.owner!.login,
      repo: pullRequest.base.repo.name,
      pull_number: pullRequest.number,
    });
    return data;
  }

  async releaseCoder(issueId: AgentId): Promise<void> {
    const coder = AgentFactory.getCoder(issueId);
    if (!coder) return;

    coder.kill();
    await this.deleteManagedWorkspace(coder.root);
    AgentFactory.deleteCoder(issueId);
  }

  releaseReviewer(prId: AgentId): void {
    const reviewer = AgentFactory.getReviewer(prId);
    reviewer?.kill();
    AgentFactory.deleteReviewer(prId);
  }

  async releaseTester(testerId: AgentId): Promise<void> {
    const tester = AgentFactory.getTester(testerId);
    if (!tester) return;

    tester.kill();
    await this.deleteManagedWorkspace(tester.root);
    AgentFactory.deleteTester(testerId);
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
    await Promise.all(
      linkedIssues.map((issue) => this.releaseCoder(issue.id)),
    );
    this.releaseReviewer(pullRequest.id);
  }

  async spawnATesterToFindBugs(repository: Repository): Promise<number> {
    const rootPath = formatTemplate(
      settings.workspace.testerDirectoryTemplate,
      {
        repositoryPrefix: repository.name.substring(
          0,
          settings.workspace.repositoryPrefixLength,
        ),
      },
    );
    const workspacePath = await this.setupWorkspace(rootPath, repository);
    const tester = AgentFactory.createTester(repository.id, workspacePath);

    try {
      return await tester.findBugs();
    } finally {
      await this.releaseTester(repository.id);
    }
  }

  private async deleteManagedWorkspace(root?: string): Promise<void> {
    if (!root) return;

    const workspacePath = path.resolve(root);
    const workspaceBase = path.resolve(process.cwd());
    const relativePath = path.relative(workspaceBase, workspacePath);
    const isOutsideWorkspace =
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath);

    if (
      !relativePath ||
      isOutsideWorkspace ||
      !this.managedWorkspaces.has(workspacePath)
    ) {
      throw new Error(
        `Refusing to delete unmanaged workspace: ${workspacePath}`,
      );
    }

    await rm(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    this.managedWorkspaces.delete(workspacePath);
  }

  private linkedIssuesCacheKey(
    owner: string,
    repo: string,
    pr: number,
  ): string {
    return `${owner}/${repo}#${pr}`;
  }
}
