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
  };
  agents: {
    workerType: "codex" | "claude";
    reviewerType: "codex" | "claude";
  };
  prompts: {
    workOnIssue: string;
    reviewPullRequest: string;
    addressReview: string;
  };
  queries: {
    linkedIssues: string;
  };
}
