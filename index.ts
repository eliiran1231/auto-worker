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
import { logger } from "./utils/logger.js";
import { flushFailureEmails } from "./utils/failureEmail.js";

let exiting = false;
function fatalFailure(error: unknown): void {
  logger.error("Auto-worker stopped unexpectedly", { error });
  if (exiting) return;
  exiting = true;
  const deadline = setTimeout(() => process.exit(1), 20000);
  void flushFailureEmails().finally(() => {
    clearTimeout(deadline);
    process.exit(1);
  });
}
process.on("uncaughtException", fatalFailure);
process.on("unhandledRejection", fatalFailure);

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

if (process.argv.includes("--lan")) {
  app.use(createDashboardApp(workerStore, orchestrator, { allowLan: true }));
  app.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard, API and webhooks: http://<this-computer-LAN-IP>:${port}`);
  });
} else {
app.listen(port, () => {
  console.log(`🚀 Server is listening for GitHub webhooks on port ${port}`);
});

createDashboardApp(workerStore, orchestrator).listen(settings.server.dashboardPort, "127.0.0.1", () => {
  console.log(`Dashboard: http://127.0.0.1:${settings.server.dashboardPort}`);
});
}
