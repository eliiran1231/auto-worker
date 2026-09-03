import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type ClosedPullRequest = EmitterWebhookEvent<"pull_request.closed">["payload"]["pull_request"];
export type PullRequest = EmitterWebhookEvent<"pull_request">["payload"]["pull_request"];