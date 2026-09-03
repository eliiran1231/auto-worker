import path from "node:path";
import { Octokit } from "octokit";
import { simpleGit } from "simple-git";
import { AgentFactory } from "./AgentFactory.js";
import type { LinkedIssue } from "./interfaces/LinkedIssue.js";
import type { LinkedIssuesResponse } from "./interfaces/LinkedIssuesResponse.js";
import type { Repository } from "./interfaces/Repository.js";
import { settings } from "./settings.js";
import type { WorkItem } from "./interfaces/WorkItem.js";
import type { IssueAssignedEvent } from "./types/IssueAssignedEvent.js";
import type { PullRequestClosedEvent } from "./types/PullRequestClosedEvent.js";
import type { PullRequestReviewEvent } from "./types/PullRequestReviewEvent.js";
import type { PullRequestReviewRequestEvent } from "./types/PullRequestReviewRequestEvent.js";
import { AgentId } from "./types/AgentId.js";

const git = simpleGit();
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const linkedIssuesMap = new Map<string, LinkedIssue[]>();

const linkedIssuesCacheKey = (
  owner: string,
  repo: string,
  pr: number,
): string => `${owner}/${repo}#${pr}`;

const formatTemplate = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    key in values ? String(values[key]) : placeholder,
  );

export const getLinkedIssues = async (
  pr: number,
  repo: string,
  owner: string,
): Promise<LinkedIssue[]> => {
  const cacheKey = linkedIssuesCacheKey(owner, repo, pr);
  const cachedIssues = linkedIssuesMap.get(cacheKey);
  if (cachedIssues) return cachedIssues;

  const { repository } = await octokit.graphql<LinkedIssuesResponse>(
    settings.queries.linkedIssues,
    {
      owner,
      repo: repo,
      pr: pr,
      limit: settings.github.linkedIssuesLimit,
    },
  );

  const issues = repository.pullRequest.closingIssuesReferences.nodes;
  linkedIssuesMap.set(cacheKey, issues);
  return issues;
};

export const setupWorkspace = async (
  issue: WorkItem,
  repository: Repository,
): Promise<string> => {
  const clonedRepoPath = formatTemplate(
    settings.workspace.issueDirectoryTemplate,
    {
      repositoryPrefix: repository.name.slice(
        0,
        settings.workspace.repositoryPrefixLength,
      ),
      issueNumber: issue.number,
    },
  );
  await git.clone(repository.clone_url, clonedRepoPath);
  return path.resolve(clonedRepoPath);
};

export const workOnIssue = async ({
  payload,
}: IssueAssignedEvent): Promise<void> => {
  if (payload.issue.assignee?.login !== settings.github.username) {
    return;
  }

  const repoPath = await setupWorkspace(payload.issue, payload.repository);
  const worker = AgentFactory.createWorker(payload.issue.id, repoPath);
  await worker.spawn(
    formatTemplate(settings.prompts.workOnIssue, {
      issueNumber: payload.issue.number,
    }),
  );
};

export const requestReview = async ({
  payload,
}: PullRequestReviewRequestEvent): Promise<void> => {
  const pullRequest = payload.pull_request;
  if (
    pullRequest.assignee?.login !== settings.github.username ||
    pullRequest.draft
  ) {
    return;
  }

  const reviewer = 
   AgentFactory.getReviewer(pullRequest.id) ??
   AgentFactory.createReviewer(pullRequest.id);
  await reviewer?.spawn(
    formatTemplate(settings.prompts.reviewPullRequest, {
      pullRequestUrl: pullRequest.url,
    }),
  );
};

export const addressReview = async ({
  payload,
}: PullRequestReviewEvent): Promise<void> => {
  const review = payload.review;
  const pullRequest = payload.pull_request;
  if (
    review.user!.login !== settings.github.username ||
    pullRequest.draft
  ) {
    return;
  }

  const repo = pullRequest.base.repo.name;
  const owner = pullRequest.base.repo.owner!.login;
  const linkedIssues = await getLinkedIssues(
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
    formatTemplate(settings.prompts.addressReview, {
      pullRequestUrl: pullRequest.url,
    }),
  );
};

export const mergePullRequest = async ({ payload }: PullRequestReviewEvent) => {
  const pullRequest = payload.pull_request;
  const { data } = await octokit.rest.pulls.merge({
    owner: pullRequest.base.repo.owner!.login,
    repo: pullRequest.base.repo.name,
    pull_number: pullRequest.number,
  });
  return data;
};

export const releaseWorker = (issueId: AgentId): void => {
  const worker = AgentFactory.getWorker(issueId);
  worker?.kill();
  AgentFactory.deleteWorker(issueId);
};

export const releaseReviewer = (prId: AgentId): void => {
  const reviewer = AgentFactory.getReviewer(prId);
  reviewer?.kill();
  AgentFactory.deleteReviewer(prId);
};

export const iterationCleanup = async ({
  payload,
}: PullRequestClosedEvent): Promise<void> => {
  const pullRequest = payload.pull_request;
  const repo = pullRequest.base.repo.name;
  const owner = pullRequest.base.repo.owner!.login;
  const linkedIssues = await getLinkedIssues(
    pullRequest.number,
    repo,
    owner,
  );

  linkedIssuesMap.delete(linkedIssuesCacheKey(owner, repo, pullRequest.number));
  linkedIssues.forEach((issue) => releaseWorker(issue.id));
  releaseReviewer(pullRequest.id);
};
