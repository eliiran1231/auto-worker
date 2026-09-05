import type { Repository } from "./Repository.js";

export interface TesterScanState {
  repository: Repository;
  pending: boolean;
  promise: Promise<string>;
}
