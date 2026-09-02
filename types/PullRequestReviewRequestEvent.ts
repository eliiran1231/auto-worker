import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type PullRequestReviewRequestEvent = EmitterWebhookEvent<
  "pull_request.opened" | "pull_request.ready_for_review"
>;
