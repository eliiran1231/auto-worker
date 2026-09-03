import express from "express";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import "dotenv/config";
import { settings } from "./settings.js";
import {
  addressReview,
  iterationCleanup,
  mergePullRequest,
  requestReview,
  workOnIssue,
} from "./functions.js";

const app = express();
const port = settings.server.port;

const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET!,
});

webhooks.on("issues.assigned", workOnIssue);
webhooks.on("pull_request.opened", requestReview);
webhooks.on("pull_request_review.submitted", async (event) => {
  switch (event.payload.review.state.toLowerCase()) {
    case "approved":
      await mergePullRequest(event);
      break;

    case "changes_requested":
      await addressReview(event);
      break;
  }
});
webhooks.on("pull_request.ready_for_review", requestReview);
webhooks.on("pull_request.closed", iterationCleanup);

app.use(settings.server.webhookPath, createNodeMiddleware(webhooks));

app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});
