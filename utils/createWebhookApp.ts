import express from "express";
import { createNodeMiddleware, type Webhooks } from "@octokit/webhooks";
import { settings } from "../settings.js";

export function createWebhookApp(webhooks: Webhooks) {
  const app = express();
  // Octokit matches request.url itself; an Express path mount strips that path.
  app.use(createNodeMiddleware(webhooks, { path: settings.server.webhookPath }));
  return app;
}
