import type { LinkedBranch } from "./LinkedBranch.js";

export interface LinkedBranchesResponse {
  repository: {
    issue: {
      linkedBranches: {
        nodes: LinkedBranch[];
      };
    };
  };
}
