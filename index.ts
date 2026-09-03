import express from "express";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import "dotenv/config";
import { Orchestrator } from "./agents/Orchestrator.js";
import { settings } from "./settings.js";
import { AgentFactory } from "./AgentFactory.js";

const app = express();
const port = settings.server.port;
const orchestrator = new Orchestrator();

const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET!,
});

webhooks.on("issues.assigned", ({ payload }) =>
   orchestrator.spawnWorkerToResolveIssue(payload.issue, payload.repository)
);

webhooks.on("pull_request.opened", ({ payload }) => 
  orchestrator.spawnReviewerForPR(payload.pull_request)
);
webhooks.on("pull_request_review.submitted", async ({ payload }) => {
  const pullRequest = payload.pull_request;
  switch (payload.review.state.toLowerCase()) {
    case "approved":
      if (payload.review.user!.login !== settings.github.username || pullRequest.draft) {
        return;
      }
      await orchestrator.mergePullRequest(pullRequest);
      break;

    case "changes_requested":
      if (payload.review.user!.login !== settings.github.username || pullRequest.draft) {
        return;
      }
      await orchestrator.tellAssignedWorkerToAddressReview(pullRequest);
      await orchestrator.makePullRequestReadyForReview(pullRequest);
      break;
  }
});
webhooks.on("pull_request.ready_for_review", async ({payload}) => {
  const pullRequest = payload.pull_request;
  const hasReviewer = !!AgentFactory.getReviewer(payload.pull_request.id);
  hasReviewer ?
   await orchestrator.tellReviewerToReReviewPR(pullRequest) :
   await orchestrator.spawnReviewerForPR(pullRequest);
});
webhooks.on("pull_request.closed", async ({ payload }) => 
  await orchestrator.iterationCleanup(payload.pull_request)
);

app.use(settings.server.webhookPath, createNodeMiddleware(webhooks));

app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});
