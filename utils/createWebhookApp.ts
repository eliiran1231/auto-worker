import express from "express";
import { createNodeMiddleware, type Webhooks } from "@octokit/webhooks";
import { settings } from "../settings.js";
import { logger, withLogContext } from "./logger.js";

export function createWebhookApp(webhooks: Webhooks) {
  const app = express();
  app.use((request, response, next) => {
    const fields = {
      deliveryId: request.get("x-github-delivery"),
      event: request.get("x-github-event"),
      method: request.method,
      path: request.path,
    };
    withLogContext(fields, () => {
      next();
    });
  });
  // Octokit matches request.url itself; an Express path mount strips that path.
  app.use(createNodeMiddleware(webhooks, {
    path: settings.server.webhookPath,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (error) => logger.error("Webhook request rejected", { error: error instanceof Error ? error : String(error) }),
    },
  }));
  return app;
}
