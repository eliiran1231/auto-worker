import { registerWebhooks } from "./utils/registerWebhooks.js";
import { Webhooks } from "@octokit/webhooks";
import { createWebhookApp } from "./utils/createWebhookApp.js";
import "dotenv/config";
import { Orchestrator } from "./agents/Orchestrator.js";
import { settings } from "./settings.js";

const port = settings.server.port;
const orchestrator = new Orchestrator();

const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET!,
});

registerWebhooks(webhooks, orchestrator);

const app = createWebhookApp(webhooks);

app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});
