import { registerWebhooks } from "./utils/registerWebhooks.js";
import express from "express";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import "dotenv/config";
import { Orchestrator } from "./agents/Orchestrator.js";
import { settings } from "./settings.js";

const app = express();
const port = settings.server.port;
const orchestrator = new Orchestrator();

const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET!,
});

registerWebhooks(webhooks, orchestrator);

app.use(settings.server.webhookPath, createNodeMiddleware(webhooks));

app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});
