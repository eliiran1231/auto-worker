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
    workerType: "codex" | "claude";
    reviewerType: "codex" | "claude";
    testerType: "codex" | "claude";
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
