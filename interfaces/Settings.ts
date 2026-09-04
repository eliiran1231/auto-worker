import type { WorkerType } from "../classes/Worker.js";
export interface Settings {
  server: {
    port: number;
    webhookPath: string;
  };
  github: {
    username: string;
    linkedIssuesLimit: number;
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
  prompts: {
    writeTests: string;
    analyzeTestResultsAndCreateIssues: string;
    reReviewPullRequest: string;
    workOnIssue: string;
    reviewPullRequest: string;
    addressReview: string;
    findBugs: string;
  };
  queries: {
    linkedIssues: string;
  };
}
