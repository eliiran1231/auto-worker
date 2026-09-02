import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type PullRequestClosedEvent =
  EmitterWebhookEvent<"pull_request.closed">;
