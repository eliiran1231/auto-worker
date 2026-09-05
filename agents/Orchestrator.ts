import { rm } from "node:fs/promises";
import path from "node:path";
import { Octokit } from "octokit";
import { setTimeout as delay } from "node:timers/promises";
import { AgentFactory } from "../AgentFactory.js";
import type { LinkedIssue } from "../interfaces/LinkedIssue.js";
import type { LinkedBranch } from "../interfaces/LinkedBranch.js";
import type { LinkedBranchesResponse } from "../interfaces/LinkedBranchesResponse.js";
import type { Issue } from "../types/Issue.js";
import type { LinkedIssuesResponse } from "../interfaces/LinkedIssuesResponse.js";
import type { Repository } from "../interfaces/Repository.js";
import { settings } from "../settings.js";
import type { AgentId } from "../types/AgentId.js";
import type { PullRequest } from "../types/PullRequest.js";
import { formatTemplate } from "../utils/templates.js";
import { getGitHubToken } from "../utils/github.js";
import { createRoleGit } from "../utils/git.js";
import type { TesterScanState } from "../interfaces/TesterScanState.js";
import type { WorkerRole } from "../types/WorkerRole.js";

export class Orchestrator {
  private readonly octokit = new Octokit({
    auth: getGitHubToken("coder"),
  });
  private readonly linkedIssuesMap = new Map<string, LinkedIssue[]>();
  private readonly managedWorkspaces = new Set<string>();
  private readonly testerScans = new Map<number, TesterScanState>();

  private async waitForLinkedBranch(issue: Issue, repository: Repository): Promise<string> {
    const { linkedBranchAttempts, linkedBranchRetryMs } = settings.github;
    for (let attempt = 0; attempt < linkedBranchAttempts; attempt++) {
      const branches = await this.getLinkedBranches(issue.number, repository);
      if (branches.length === 1 && branches[0].ref) return branches[0].ref.name;
      if (branches.length > 1) break;
      if (attempt + 1 < linkedBranchAttempts) await delay(linkedBranchRetryMs);
    }
    throw new Error(`Expected exactly one linked branch with a non-null ref for issue #${issue.number}`);
  }

  private async getLinkedBranches(
    issueNumber: number,
    repository: Repository,
  ): Promise<LinkedBranch[]> {
    const result = await this.octokit.graphql<LinkedBranchesResponse>(
      settings.queries.linkedBranches,
      {
        owner: repository.owner.login,
        repo: repository.name,
        issue: issueNumber,
      },
    );

    return result.repository.issue.linkedBranches.nodes;
  }

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
    role: WorkerRole = "coder",
  ): Promise<string> {
    const workspacePath = path.resolve(clonedRepoPath);
    await createRoleGit(process.cwd(), role)
      .clone(repository.clone_url, workspacePath);
    this.managedWorkspaces.add(workspacePath);
    return workspacePath;
  }

  async spawnWorkerToResolveIssue(issue: Issue, repository: Repository): Promise<void> {
    if (issue.assignee?.login !== settings.github.username) {
      return;
    }
    const branch = await this.waitForLinkedBranch(issue, repository);
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
    const git = createRoleGit(workspacePath, "coder");
    await git.fetch();
    await git.checkout([
      "-b", 
      `farm/i-${issue.number}`,
      `origin/${branch}`,
    ]);
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
    if (coder.status != "working") await coder.addressReview(pullRequest);
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

  spawnATesterToFindBugs(repository: Repository): Promise<string> {
    const active = this.testerScans.get(repository.id);
    if (active) {
      active.repository = repository;
      active.pending = true;
      return active.promise;
    }
    const state: TesterScanState = { repository, pending: false, promise: Promise.resolve("") };
    this.testerScans.set(repository.id, state);
    state.promise = Promise.resolve().then(async () => {
      let branch = "";
      const errors: unknown[] = [];
      try {
        do {
          state.pending = false;
          try {
            branch = await this.runTesterScan(state.repository);
          } catch (error) {
            errors.push(error);
          }
        } while (state.pending);
        if (errors.length) throw new AggregateError(errors, `Tester scan failed for repository ${repository.id}`);
        return branch;
      } finally {
        this.testerScans.delete(repository.id);
      }
    });
    return state.promise;
  }

  private async runTesterScan(repository: Repository): Promise<string> {
    const workflowId = settings.tests.differential.trim();
    if (!workflowId) {
      throw new Error("Set tests.differential in settings.json to the workflow file name or ID");
    }
    const rootPath = formatTemplate(
      settings.workspace.testerDirectoryTemplate,
      {
        repositoryId: repository.id,
        repositoryPrefix: repository.name.substring(
          0,
          settings.workspace.repositoryPrefixLength,
        ),
      },
    );
    const workspacePath = await this.setupWorkspace(rootPath, repository, "tester");
    const tester = AgentFactory.createTester(repository.id, workspacePath);
    try {
      const git = createRoleGit(workspacePath, "tester");
      const newBranch = `farm/tests-${Date.now()}`;
      await git.checkoutLocalBranch(newBranch)
      await tester.writeTests();
      await git.push("origin", newBranch, ["--set-upstream"]);
      let workflowRun = await tester.runTest(repository, workflowId, newBranch);
      while (workflowRun.conclusion == "success"){
        await tester.continueWritingTests();
        await git.push("origin", newBranch, ["--set-upstream"]);
        workflowRun = await tester.runTest(repository, workflowId, newBranch)
      }
      if (workflowRun.conclusion !== "failure") {
        throw new Error(
          `Unexpected workflow conclusion: ${workflowRun.conclusion}`,
        );
      }
      await tester.analyzeTestResultsAndCreateIssues(workflowRun);
      return newBranch;
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
