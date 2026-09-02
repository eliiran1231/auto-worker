import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type PullRequest = EmitterWebhookEvent<"pull_request.closed">["payload"]["pull_request"];
