import type { LinkedIssue } from "./LinkedIssue.js";

export interface LinkedIssuesResponse {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: (Omit<LinkedIssue, "id"> & { id: string | number | null })[];
      };
    };
  };
}
