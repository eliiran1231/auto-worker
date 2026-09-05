import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Webhooks } from "@octokit/webhooks";
import { createWebhookApp } from "../utils/createWebhookApp.ts";
import { settings } from "../settings.ts";

test("the configured HTTP endpoint accepts signed deliveries and rejects invalid signatures", async () => {
  const hooks = new Webhooks({ secret: "http-test-secret" });
  const deliveries = [];
  hooks.on("ping", event => { deliveries.push(event.id); });
  const server = createWebhookApp(hooks).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify({ zen: "HTTP routing test" });
    const headers = {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-github-delivery": "test-delivery",
      "x-hub-signature-256": await hooks.sign(body),
    };
    const response = await fetch(url + settings.server.webhookPath, { method: "POST", headers, body });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(deliveries, ["test-delivery"]);
    const invalid = await fetch(url + settings.server.webhookPath, {
      method: "POST", headers: { ...headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body,
    });
    assert.equal(invalid.status, 400);
    assert.equal(deliveries.length, 1);
    const wrongPath = await fetch(url + "/not-the-webhook", { method: "POST", headers, body });
    assert.equal(wrongPath.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
