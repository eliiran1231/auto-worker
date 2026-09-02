import path from "node:path";
import { Octokit } from "octokit";
import { simpleGit } from "simple-git";
import { AgentFactory } from "./AgentFactory.js";
import type { Worker } from "./agents/Worker.js";
import type { LinkedIssue } from "./interfaces/LinkedIssue.js";
import type { LinkedIssuesResponse } from "./interfaces/LinkedIssuesResponse.js";
import type { Repository } from "./interfaces/Repository.js";
import type { WorkItem } from "./interfaces/WorkItem.js";
import type { IssueAssignedEvent } from "./types/IssueAssignedEvent.js";
import type { PullRequest } from "./types/PullRequest.js";
import type { PullRequestClosedEvent } from "./types/PullRequestClosedEvent.js";
import type { PullRequestReviewEvent } from "./types/PullRequestReviewEvent.js";
import type { PullRequestReviewRequestEvent } from "./types/PullRequestReviewRequestEvent.js";
import { AgentId } from "./types/AgentId.js";

const git = simpleGit();
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export const getLinkedIssues = async (
  pullRequest: PullRequest,
): Promise<LinkedIssue[]> => {
  const { repository } = await octokit.graphql<LinkedIssuesResponse>(
    `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            closingIssuesReferences(first: 10) {
              nodes {
                id
                number
                title
              }
            }
          }
        }
      }
    `,
    {
      owner: pullRequest.base.repo.owner.login,
      repo: pullRequest.base.repo.name,
      pr: pullRequest.number,
    },
  );

  return repository.pullRequest.closingIssuesReferences.nodes;
};

export const setupWorkspace = async (
  issue: WorkItem,
  repository: Repository,
): Promise<string> => {
  const clonedRepoPath = `./${repository.name.slice(0, 3)}-i-${issue.number}`;
  await git.clone(repository.clone_url, clonedRepoPath);
  return path.resolve(clonedRepoPath);
};

export const workOnIssue = async ({
  payload,
}: IssueAssignedEvent): Promise<void> => {
  if (payload.issue.assignee?.login !== process.env.GITHUB_USERNAME) {
    return;
  }

  const repoPath = await setupWorkspace(payload.issue, payload.repository);
  const worker = AgentFactory.createWorker(payload.issue.id, repoPath);
  await worker.spawn(
    `work on issue #${payload.issue.number} and open a PR`,
  );
};

export const requestReview = async ({
  payload,
}: PullRequestReviewRequestEvent): Promise<void> => {
  const pullRequest = payload.pull_request;
  if (
    pullRequest.assignee?.login !== process.env.GITHUB_USERNAME ||
    pullRequest.draft
  ) {
    return;
  }

  const reviewer = 
   AgentFactory.getReviewer(pullRequest.id) ??
   AgentFactory.createReviewer(pullRequest.id);
  await reviewer?.spawn(
    `review this pull request ${pullRequest.url}. if you approve, submit approval if you don't approve, submit changes requested with your feedback. make sure to run the differential test before approving`,
  );
};

export const addressReview = async ({
  payload,
}: PullRequestReviewEvent): Promise<void> => {
  const review = payload.review;
  const pullRequest = payload.pull_request;
  if (
    review.user!.login !== process.env.GITHUB_USERNAME ||
    pullRequest.draft
  ) {
    return;
  }

  const worker = AgentFactory.getWorker(pullRequest.id);
  await worker?.send(`you got a review on ${pullRequest.url}`);
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

export const iterationCleanup = async ({ payload }: PullRequestClosedEvent): Promise<void> => {
  const pullRequest = payload.pull_request;
  const linkedIssues = await getLinkedIssues(pullRequest);
  linkedIssues.forEach((issue) => releaseWorker(issue.id));
  releaseReviewer(pullRequest.id);
};
