import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Response } from "express";

const cookieName = "dashboard_session";
const lifetime = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();

export function installDashboardAuth(app: Express): void {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  const sessions = new Map<string, { expires: number; streams: Set<Response> }>();
  let failedAttempts = 0;
  let retryAt = 0;
  const tokenFrom = (cookie = "") => cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  function remove(token: string) {
    const session = sessions.get(token);
    sessions.delete(token);
    for (const stream of session?.streams ?? []) stream.end();
  }
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin) {
        let allowed = false;
        try { allowed = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname); } catch { /* reject */ }
        if (!allowed) { res.status(403).json({ error: "Dashboard requests are local only" }); return; }
      }
      if (req.get("sec-fetch-site") === "cross-site") { res.status(403).json({ error: "Cross-site request rejected" }); return; }
    }
    for (const [token, session] of sessions) if (session.expires <= Date.now()) remove(token);
    next();
  });
  app.post("/api/auth/login", (req, res) => {
    if (!username || !password) {
      res.status(503).json({ error: "Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in .env, then restart the app." }); return;
    }
    if (retryAt > Date.now()) {
      res.set("Retry-After", String(Math.ceil((retryAt - Date.now()) / 1000)));
      res.status(429).json({ error: "Too many login attempts. Try again in one minute." }); return;
    }
    const validUser = typeof req.body?.username === "string" && timingSafeEqual(digest(req.body.username), digest(username));
    const validPassword = typeof req.body?.password === "string" && timingSafeEqual(digest(req.body.password), digest(password));
    if (!validUser || !validPassword) {
      if (++failedAttempts >= 5) { retryAt = Date.now() + 60000; failedAttempts = 0; }
      res.status(401).json({ error: "Invalid username or password" }); return;
    }
    failedAttempts = 0;
    const previous = tokenFrom(req.headers.cookie);
    if (previous) remove(previous);
    if (sessions.size >= 100) remove(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { expires: Date.now() + lifetime, streams: new Set() });
    res.cookie(cookieName, token, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/", maxAge: lifetime });
    res.json({ authenticated: true });
  });
  app.use("/api", (req, res, next) => {
    const token = tokenFrom(req.headers.cookie);
    const session = token ? sessions.get(token) : undefined;
    if (!session) { res.status(401).json({ error: "Please sign in" }); return; }
    if (req.path === "/events") {
      session.streams.add(res);
      const timer = setTimeout(() => remove(token!), session.expires - Date.now());
      res.on("close", () => { clearTimeout(timer); session.streams.delete(res); });
    }
    next();
  });
  app.get("/api/auth/session", (_req, res) => res.json({ authenticated: true }));
  app.post("/api/auth/logout", (req, res) => {
    const token = tokenFrom(req.headers.cookie);
    if (token) remove(token);
    res.clearCookie(cookieName, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/" });
    res.json({ authenticated: false });
  });
}
