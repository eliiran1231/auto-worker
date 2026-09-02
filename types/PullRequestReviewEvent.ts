import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type PullRequestReviewEvent =
  EmitterWebhookEvent<"pull_request_review.submitted">;
