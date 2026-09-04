import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type WorkflowRun = EmitterWebhookEvent<"workflow_run.completed">["payload"]["workflow_run"];
