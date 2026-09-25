import { registerWebhooks } from "./utils/registerWebhooks.js";
import { Webhooks } from "@octokit/webhooks";
import { createWebhookApp } from "./utils/createWebhookApp.js";
import "dotenv/config";
import { Orchestrator } from "./agents/Orchestrator.js";
import { settings } from "./settings.js";
import { AgentFactory } from "./AgentFactory.js";
import { WorkerStore } from "./classes/WorkerStore.js";
import path from "node:path";
import { createDashboardApp } from "./utils/createDashboardApp.js";

const workerStore = new WorkerStore(path.resolve(process.env.WORKER_DB_PATH ?? "data/workers.sqlite"));
AgentFactory.restoreFrom(workerStore);
AgentFactory.resumePendingTurns();

const port = settings.server.port;
const orchestrator = new Orchestrator(workerStore);
orchestrator.recoverTesterScans();

const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET!,
});

registerWebhooks(webhooks, orchestrator);

const app = createWebhookApp(webhooks);

app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});

createDashboardApp(workerStore).listen(settings.server.dashboardPort, "127.0.0.1", () => {
  console.log(`Dashboard: http://127.0.0.1:${settings.server.dashboardPort}`);
});
