import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type IssueAssignedEvent = EmitterWebhookEvent<"issues.assigned">;
