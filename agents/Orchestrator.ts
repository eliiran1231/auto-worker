import { rm } from "node:fs/promises";
import path from "node:path";
import { Octokit } from "octokit";
import { AgentFactory } from "../AgentFactory.js";
import type { LinkedIssue } from "../interfaces/LinkedIssue.js";
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
import { WorkerStore, type SavedScan } from "../classes/WorkerStore.js";
import { logger } from "../utils/logger.js";

export class Orchestrator {
  private readonly octokit = new Octokit({
    auth: getGitHubToken("coder"),
  });
  private readonly linkedIssuesMap = new Map<string, LinkedIssue[]>();
  private readonly managedWorkspaces = new Set<string>();
  private readonly testerScans = new Map<number, TesterScanState>();

  constructor(private readonly store?: WorkerStore) {
    for (const worker of [...Object.values(AgentFactory.coders), ...Object.values(AgentFactory.testers)]) {
      if (!worker.root) continue;
      const root = path.resolve(worker.root);
      const relative = path.relative(path.resolve(process.cwd()), root);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        this.managedWorkspaces.add(root);
      }
    }
  }

  recoverTesterScans(): void {
    for (const scan of this.store?.loadScans() ?? []) {
      void this.spawnATesterToFindBugs(scan.repository).catch(error =>
        logger.error("Recovered tester scan failed", { repositoryId: scan.repository.id, error }));
    }
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
    if (AgentFactory.getCoder(issue.id)) return;
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
      "origin/dev",
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

    if (AgentFactory.getReviewer(pullRequest.id)) return;

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
    let scan = this.store?.loadScans().find(saved => saved.repository.id === repository.id);
    const restoredTester = scan ? AgentFactory.getTester(repository.id) : undefined;
    const workspacePath = scan
      ? path.resolve(restoredTester?.root ?? rootPath)
      : await this.setupWorkspace(rootPath, repository, "tester");
    const tester = scan
      ? restoredTester ?? AgentFactory.createTester(repository.id, workspacePath)
      : AgentFactory.createTester(repository.id, workspacePath);
    try {
      const git = createRoleGit(workspacePath, "tester");
      if (!scan) {
        const branch = `farm/tests-${Date.now()}`;
        await git.fetch("origin", "dev");
        await git.checkout(["-b", branch, "origin/dev"]);
        scan = { repository, branch, phase: "writing" };
        this.store?.saveScan(scan);
      }
      const newBranch = scan.branch;
      if (scan.phase === "writing") {
        const resumed = await tester.resumePendingTurns();
        if (resumed.length === 0) await tester.writeTests();
        scan.phase = "testing";
        this.store?.saveScan(scan);
      } else if (scan.phase === "testing") {
        await tester.resumePendingTurns();
      }
      if (scan.phase === "testing") {
        await git.push("origin", newBranch, ["--set-upstream"]);
        let workflowRun = await tester.runTest(repository, workflowId, newBranch);
        while (workflowRun.conclusion === "success") {
          await tester.continueWritingTests();
          await git.push("origin", newBranch, ["--set-upstream"]);
          workflowRun = await tester.runTest(repository, workflowId, newBranch);
        }
        if (workflowRun.conclusion !== "failure") {
          throw new Error(`Unexpected workflow conclusion: ${workflowRun.conclusion}`);
        }
        scan.workflowRun = workflowRun;
        scan.phase = "analyzing";
        this.store?.saveScan(scan);
      }
      if (!scan.workflowRun) throw new Error("Missing completed tester workflow run");
      await git.fetch("origin", "dev");
      await git.checkout(["-B", "dev", "origin/dev"]);
      await git.merge(["--no-ff", newBranch]);
      await git.push("origin", "dev");
      const resumedAnalysis = await tester.resumePendingTurns();
      if (resumedAnalysis.length === 0) await tester.analyzeTestResultsAndCreateIssues(scan.workflowRun);
      this.store?.deleteScan(repository.id);
      return newBranch;
    } finally {
      if (!this.store?.loadScans().some(saved => saved.repository.id === repository.id)) {
        await this.releaseTester(repository.id);
      }
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
