import type { Webhooks } from "@octokit/webhooks";
import type { EmitterWebhookEventName, EmitterWebhookEvent } from "@octokit/webhooks";
import type { Orchestrator } from "../agents/Orchestrator.js";
import { settings } from "../settings.js";
import { AgentFactory } from "../AgentFactory.js";
import { WorkflowManager } from "../classes/workflowManager.js";

export function registerWebhooks(webhooks: Webhooks, orchestrator: Orchestrator): void {
  function onBackground<E extends EmitterWebhookEventName>(
    name: E,
    work: (event: EmitterWebhookEvent<E>) => unknown,
  ): void {
    webhooks.on(name, (event) => {
      void Promise.resolve().then(() => work(event as EmitterWebhookEvent<E>)).catch((error: unknown) => {
        console.error(`Webhook ${name} (${event.id}) failed`, error);
      });
    });
  }
  onBackground("issues.assigned", ({ payload }) =>
     orchestrator.spawnWorkerToResolveIssue(payload.issue, payload.repository)
  );

  onBackground("pull_request.opened", ({ payload }) =>
    orchestrator.spawnReviewerForPR(payload.pull_request)
  );
  onBackground("pull_request_review.submitted", async ({ payload }) => {
    const pullRequest = payload.pull_request;
    switch (payload.review.state.toLowerCase()) {
      case "approved":
        if (pullRequest.draft) {
          return;
        }
        await orchestrator.mergePullRequest(pullRequest);
        break;

      case "changes_requested":
        if (pullRequest.draft) {
          return;
        }
        await orchestrator.tellAssignedWorkerToAddressReview(pullRequest);
        break;
    }
  });

  onBackground("pull_request.synchronize", async ({payload}) => {
    const pullRequest = payload.pull_request;
    if (pullRequest.assignee?.login !== settings.github.username
      || pullRequest.draft
      || pullRequest.state.toLowerCase() !== "open"
    ) {
      return;
    }
    const reviewer = AgentFactory.getReviewer(payload.pull_request.id);
    if (reviewer) {
      if (reviewer.status === "idle") {
        await orchestrator.tellReviewerToReReviewPR(pullRequest);
      }
    } else await orchestrator.spawnReviewerForPR(pullRequest);
  });

  onBackground("pull_request.closed", async ({ payload }) => {
    await orchestrator.iterationCleanup(payload.pull_request);
    if (!payload.pull_request.merged) return;
    await orchestrator.spawnATesterToFindBugs(payload.repository);
  });

  webhooks.on("workflow_run.completed", ({ payload }) => {
    const workflowRun = payload.workflow_run;
    WorkflowManager.notifyWorkflowRunCompleted(payload.repository, workflowRun);
  });

}
