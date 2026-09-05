import type { WorkerType } from "../classes/Worker.js";
export interface Settings {
  server: {
    port: number;
    webhookPath: string;
  };
  github: {
    username: string;
    linkedIssuesLimit: number;
    linkedBranchAttempts: number;
    linkedBranchRetryMs: number;
  };
  workspace: {
    defaultRoot: string;
    repositoryPrefixLength: number;
    issueDirectoryTemplate: string;
    testerDirectoryTemplate: string;
  };
  agents: {
    coderType: WorkerType;
    reviewerType: WorkerType;
    testerType: WorkerType;
  };
  tests: {
    differential: string;
    workflowTimeoutMs: number;
    completionReplayLimit: number;
    completionReplayMs: number;
  };
  prompts: {
    continueWritingTests: string;
    writeTests: string;
    analyzeTestResultsAndCreateIssues: string;
    reReviewPullRequest: string;
    workOnIssue: string;
    reviewPullRequest: string;
    addressReview: string;
  };
  queries: {
    linkedBranches: string;
    linkedIssues: string;
  };
}
