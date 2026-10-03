import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { WorkerStore } from "../classes/WorkerStore.js";
import { settings, updateSettings } from "../settings.js";
import type { Orchestrator } from "../agents/Orchestrator.js";
import { logger, redact } from "./logger.js";
import { AgentFactory } from "../AgentFactory.js";
import { sendTestEmail } from "./failureEmail.js";
import { installDashboardAuth } from "./dashboardAuth.js";

export function createDashboardApp(store: WorkerStore, orchestrator?: Pick<Orchestrator, "startTesterScan">, options: { allowLan?: boolean } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const host = request.hostname.toLowerCase();
    if (!options.allowLan && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      response.status(403).send("Dashboard is local only");
      return;
    }
    next();
  });
  app.use("/api", express.json({ limit: "128kb" }));
  installDashboardAuth(app);

  app.post("/api/tester-scans", async (request, response) => {
    const repository = request.body?.repository;
    if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository.trim())) {
      response.status(400).json({ error: "Enter a GitHub repository as owner/repository" });
      return;
    }
    if (!orchestrator) {
      response.status(503).json({ error: "Tester scans are unavailable" });
      return;
    }
    try {
      const [owner, repo] = repository.trim().split("/");
      const result = await orchestrator.startTesterScan(owner, repo);
      response.status(result.status === "started" ? 202 : 200).json(result);
    } catch (error) {
      logger.error("Could not start tester scan", { repository, error });
      response.status(400).json({ error: redact(error instanceof Error ? error.message : String(error)) });
    }
  });

  app.get("/api/agents", (_request, response) => {
    response.json(store.load(true));
  });
  app.post("/api/agents/:workerId/messages", (request, response) => {
    const message = request.body?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 32000) {
      response.status(400).json({ error: "Enter a message between 1 and 32,000 characters" });
      return;
    }
    const saved = store.load(true).find(worker => worker.workerId === request.params.workerId);
    if (!saved) {
      response.status(404).json({ error: "Agent not found" });
      return;
    }
    const worker = AgentFactory.getWorker(saved.workerId);
    if (saved.archived || !worker?.initialized) {
      response.status(409).json({ error: "This agent is not available for messages" });
      return;
    }
    try {
      void worker.send(message.trim()).catch(error =>
        logger.error("Dashboard agent message failed", { workerId: worker.workerId, error }));
      response.status(202).json({ status: "queued" });
    } catch (error) {
      logger.error("Dashboard agent message failed", { workerId: worker.workerId, error });
      response.status(409).json({ error: redact(error instanceof Error ? error.message : String(error)) });
    }
  });
  app.get("/api/agents/:workerId/events", (request, response) => {
    if (!store.load(true).some(worker => worker.workerId === request.params.workerId)) {
      response.status(404).json({ error: "Agent not found" });
      return;
    }
    const after = Number(request.query.after ?? 0);
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (!Number.isSafeInteger(after) || after < 0 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) {
      response.status(400).json({ error: "Invalid event cursor" });
      return;
    }
    response.json(before === undefined
      ? store.events(request.params.workerId, after)
      : store.olderEvents(request.params.workerId, before));
  });
  app.get("/api/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    response.write(": connected\n\n");
    const unsubscribe = store.subscribe(event => response.write(`data: ${JSON.stringify(event)}\n\n`));
    const keepAlive = setInterval(() => response.write(": ping\n\n"), 15000);
    request.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
  });
  app.get("/api/settings", (_request, response) => response.json(settings));
  app.post("/api/settings/email/test", async (request, response) => {
    try {
      const recipient = settings.email.to;
      await sendTestEmail();
      response.json({ message: `Test email accepted by the mail server for ${recipient}. Check your inbox or spam folder.` });
    } catch (error) {
      response.status(400).json({ error: redact(error instanceof Error ? error.message : "Test email failed") });
    }
  });
  app.put("/api/settings", async (request, response) => {
    try {
      response.json(await updateSettings(request.body));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const frontend = path.resolve("dashboard/dist");
  if (existsSync(frontend)) {
    app.use(express.static(frontend));
    app.get("/{*path}", (_request, response) => response.sendFile(path.join(frontend, "index.html")));
  } else {
    app.get("/", (_request, response) => response.status(503).send("Build the dashboard with npm run build"));
  }
  return app;
}
