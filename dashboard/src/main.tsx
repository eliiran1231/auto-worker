import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Role = "coder" | "reviewer" | "tester";
type Status = "working" | "idle" | "error";
type Agent = {
  agentId: string;
  workerId: string;
  role: Role;
  type: string;
  root: string | null;
  initialized: boolean;
  status: Status;
  archived?: boolean;
  pending: string[];
};
type AgentEvent = {
  id: number;
  workerId: string;
  kind: "prompt" | "output" | "status" | "activity";
  message: string;
  createdAt: string;
};
type Config = Record<string, Record<string, string | number | boolean>>;
type View = "agents" | "settings";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (response.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("session-expired"));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

function shortPath(value: string | null) {
  return value?.replaceAll("\\", "/").split("/").slice(-2).join("/") ?? "No workspace";
}

function AgentWindow({ agent, events, hasOlder, loadOlder }: { agent: Agent; events: AgentEvent[]; hasOlder: boolean; loadOlder: () => void }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const canMessage = !agent.archived && agent.initialized;

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !canMessage || !message.trim()) return;
    setSending(true);
    setNotice("");
    setSendFailed(false);
    try {
      await request(`/api/agents/${agent.workerId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      setMessage("");
      setNotice("Message queued. Follow the response in this window.");
    } catch (error) {
      setSendFailed(true);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally { setSending(false); }
  }

  const list = useRef<HTMLDivElement>(null);
  const loadingOlder = useRef(false);
  const previousHeight = useRef(0);
  useEffect(() => {
    if (!list.current) return;
    if (loadingOlder.current) {
      list.current.scrollTop = list.current.scrollHeight - previousHeight.current;
      loadingOlder.current = false;
    } else list.current.scrollTop = list.current.scrollHeight;
  }, [events.length]);
  return <section className={`agent-window ${agent.status}`}>
    <div className="window-topline" />
    <header className="window-header">
      <div className="window-identity">
        <span className={`role-icon ${agent.role}`}>{agent.role === "coder" ? "{ }" : agent.role === "reviewer" ? "◎" : "◇"}</span>
        <div>
          <div className="window-title">{agent.role}<span className="agent-number">#{agent.agentId}</span></div>
          <div className="window-subtitle">{agent.type} · {shortPath(agent.root)}</div>
        </div>
      </div>
      <span className={`status-pill ${agent.archived ? "finished" : agent.status}`}><i />{agent.archived ? "finished" : agent.status}</span>
    </header>
    <div className="window-meta"><span>SESSION <b>{agent.workerId.slice(0, 8)}</b></span><span>{agent.pending.length ? `${agent.pending.length} queued` : "queue clear"}</span></div>
    <div className="event-list" ref={list}>
      {hasOlder && <button className="load-older" onClick={() => { loadingOlder.current = true; previousHeight.current = list.current?.scrollHeight ?? 0; loadOlder(); }}>Load earlier events</button>}
      {events.length === 0 && <div className="empty-events">Waiting for this agent’s first turn.</div>}
      {events.map(event => <div className={`event ${event.kind}`} key={event.id}>
        <div className="event-heading"><span>{event.kind}</span><time>{new Date(event.createdAt).toLocaleTimeString()}</time></div>
        <div className="event-body">{event.message}</div>
      </div>)}
    </div>
    {canMessage && <form className="agent-message" onSubmit={sendMessage}>
      <label htmlFor={`message-${agent.workerId}`}>Message this {agent.role}</label>
      <textarea id={`message-${agent.workerId}`} rows={2} maxLength={32000} value={message}
        placeholder="Give feedback or instructions…" disabled={sending}
        onChange={event => { setMessage(event.target.value); setNotice(""); }} />
      <div className="agent-message-actions">
        <span>Messages run in order after the current turn.</span>
        <button className="primary-button" type="submit" disabled={sending || !message.trim()}>
          {sending ? "Sending…" : "Send message"}
        </button>
      </div>
      {notice && <p className={sendFailed ? "error-text" : ""} role={sendFailed ? "alert" : "status"}>{notice}</p>}
    </form>}
    <div className="window-footer"><span>LIVE FEED</span><span>{events.length} events</span></div>
  </section>;
}

function EmailSettings({ email, onChange, unsaved }: {
  email: Config[string];
  unsaved: boolean;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testFailed, setTestFailed] = useState(false);
  useEffect(() => { setTestResult(""); }, [email]);
  async function testEmail() {
    setTesting(true);
    setTestResult("");
    setTestFailed(false);
    try {
      const result = await request<{ message: string }>("/api/settings/email/test", { method: "POST" });
      setTestResult(result.message);
    } catch (error) {
      setTestFailed(true);
      setTestResult(error instanceof Error ? error.message : "Test email failed");
    } finally { setTesting(false); }
  }
  function field(key: string, title: string, hint: string, placeholder: string, type = "text") {
    return <label htmlFor={`email-${key}`}>
      <span>{title}</span>
      <input id={`email-${key}`} type={type} value={String(email[key] ?? "")}
        placeholder={placeholder} aria-describedby={`email-${key}-help`}
        onChange={event => onChange(key, type === "number" ? Number(event.target.value) : event.target.value)} />
      <p id={`email-${key}-help`}>{hint}</p>
    </label>;
  }
  return <section className="settings-card email-card">
    <div className="settings-card-head"><span className="settings-section-icon">@</span><div>
      <h3>Email alerts</h3><p>Get an email when a failure stops your worker or workflow.</p>
    </div></div>
    <label className="email-enable" htmlFor="email-enabled">
      <input id="email-enabled" type="checkbox" role="switch" checked={Boolean(email.enabled)}
        onChange={event => onChange("enabled", event.target.checked)} />
      <span><strong>Send failure alerts</strong><small>{email.enabled ? "On — alerts will be sent after you save." : "Off — configure the addresses below, then turn this on."}</small></span>
    </label>
    <div className="email-group">
      <h4>Who receives the alerts?</h4>
      <div className="settings-fields email-recipient">
        {field("to", "Recipient email", "Send all failure notifications to this address.", "you@example.com", "email")}
      </div>
    </div>
    <div className="email-group">
      <h4>Who sends the alerts?</h4>
      <p className="email-description">The app sends through an email account you provide. There is no built-in sender.</p>
      <div className="settings-fields">
        {field("from", "Sender email", "The address shown in the From line. Your email provider must allow this sender.", "alerts@example.com", "email")}
        {field("username", "Email account login", "Usually the sender’s email address. Leave blank only if your mail server needs no login.", "alerts@example.com")}
      </div>
    </div>
    <details className="email-connection" open={!email.host}>
      <summary>Email server setup <span>SMTP connection & password</span></summary>
      <p className="email-description">Use the SMTP settings from the provider of your sender account.</p>
      <div className="settings-fields">
        {field("host", "SMTP server", "Your provider’s outgoing mail server.", "smtp.example.com")}
        <label htmlFor="email-security"><span>Connection security</span>
          <select id="email-security" value={email.secure ? "tls" : "starttls"} aria-describedby="email-security-help"
            onChange={event => {
              const secure = event.target.value === "tls";
              onChange("secure", secure);
              if (email.port === 587 || email.port === 465) onChange("port", secure ? 465 : 587);
            }}>
            <option value="starttls">STARTTLS — usually port 587</option>
            <option value="tls">TLS — usually port 465</option>
          </select>
          <p id="email-security-help">Both options encrypt the connection. Choose the one your provider requires.</p>
        </label>
        {field("port", "SMTP port", "Filled automatically for standard connections. Change only if your provider specifies another port.", "587", "number")}
        {field("passwordEnv", "Password variable name", "This is a variable name, not your password. The app reads its value from .env.", "SMTP_PASSWORD")}
      </div>
      <div className="email-password-help"><strong>Where do I put the password?</strong>
        <p>Add this line to your <code>.env</code> file, replacing the example value with your sender account’s SMTP password or app password:</p>
        <code className="email-env-example">{String(email.passwordEnv || "SMTP_PASSWORD")}=your-smtp-password</code>
        <p>Restart the app after changing .env, then enable alerts and save settings.</p>
      </div>
    </details>
    <div className="email-test">
      <button type="button" className="secondary-button" disabled={testing || unsaved} onClick={testEmail}>
        {testing ? "Sending test email…" : "Send test email"}
      </button>
      <p>{unsaved ? "Save your email settings before sending a test." : "Uses your saved sender and recipient. Works even when failure alerts are off."}</p>
      <p role="status" aria-live="polite" className={testFailed ? "error-text" : ""}>{testResult}</p>
    </div>
  </section>;
}

function SettingsEditor({ config, onSaved }: { config: Config; onSaved: (next: Config) => void }) {
  const [draft, setDraft] = useState<Config>(() => structuredClone(config));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  useEffect(() => { setDraft(structuredClone(config)); }, [config]);

  function change(section: string, key: string, value: string | number | boolean) {
    setDraft(current => ({ ...current, [section]: { ...current[section], [key]: value } }));
    setMessage("");
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const next = await request<Config>("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      onSaved(next);
      setMessage("Settings saved and active.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  }

  return <div className="settings-page">
    <div className="section-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Live settings</h2><p>Changes apply to new work immediately. Current agent turns keep their existing prompt and engine.</p></div></div>
    <section className="settings-card">
      <div className="settings-card-head"><span className="settings-section-icon">✓</span><div><h3>Issue closure</h3><p>Choose which target branch triggers automatic issue closure.</p></div></div>
      <div className="settings-fields"><label className="wide-field" htmlFor="close-issues-branch">
        <span>Close linked issues when merging to</span>
        <input id="close-issues-branch" type="text" placeholder="dev"
          value={String(draft.github.closeLinkedIssuesWhenMergingTo ?? "dev")}
          onChange={event => change("github", "closeLinkedIssuesWhenMergingTo", event.target.value)}
          aria-describedby="close-issues-help" />
        <p id="close-issues-help">Linked issues close only after a successful merge into this branch. Default: dev.</p>
      </label></div>
    </section>
    {draft.email && <EmailSettings email={draft.email} unsaved={JSON.stringify(draft.email) !== JSON.stringify(config.email)} onChange={(key, value) => change("email", key, value)} />}
    {Object.entries(draft).filter(([section]) => section !== "email").map(([section, values]) => <section className="settings-card" key={section}>
      <div className="settings-card-head"><span className="settings-section-icon">{section.slice(0, 1).toUpperCase()}</span><div><h3>{section}</h3><p>{section === "server" ? "Listener settings are shown for reference and require a restart." : "Applied to the running server when saved."}</p></div></div>
      <div className="settings-fields">{Object.entries(values).filter(([key]) => section !== "github" || key !== "closeLinkedIssuesWhenMergingTo").map(([key, value]) => <label className={section === "prompts" || section === "queries" ? "wide-field" : ""} key={key}>
        <span>{key.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase())}</span>
        {typeof value === "boolean"
          ? <input type="checkbox" checked={value} onChange={event => change(section, key, event.target.checked)} />
          : section === "prompts" || section === "queries"
          ? <textarea value={value} disabled={section === "server"} rows={section === "prompts" ? 4 : 3} onChange={event => change(section, key, event.target.value)} />
          : section === "agents"
            ? <select value={value} onChange={event => change(section, key, event.target.value)}><option value="codex">codex</option><option value="claude">claude</option></select>
            : <input value={value} type={typeof value === "number" ? "number" : "text"} disabled={section === "server"} onChange={event => change(section, key, typeof value === "number" ? Number(event.target.value) : event.target.value)} />}
      </label>)}</div>
    </section>)}
    <div className="save-bar"><span className={message && !message.startsWith("Settings saved") ? "error-text" : ""}>{message || (dirty ? "Unsaved changes" : "All changes saved")}</span><div><button className="secondary-button" disabled={!dirty || saving} onClick={() => setDraft(structuredClone(config))}>Reset</button><button className="primary-button" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save settings"}</button></div></div>
  </div>;
}

function StartTesterScan() {
  const [repository, setRepository] = useState("");
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    setMessage("");
    setFailed(false);
    try {
      const result = await request<{ repository: string; status: "started" | "already_running" }>("/api/tester-scans", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: repository.trim() }),
      });
      setMessage(result.status === "already_running"
        ? `A scan is already running for ${result.repository}.`
        : `Scan requested for ${result.repository}. The tester window will appear after the repository is cloned.`);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setStarting(false); }
  }

  return <form className="start-scan" onSubmit={start}>
    <label htmlFor="scan-repository">Start the loop</label>
    <div className="scan-controls">
      <input id="scan-repository" placeholder="owner/repository" value={repository} required
        disabled={starting} onChange={event => setRepository(event.target.value)} />
      <button className="primary-button" disabled={starting || !repository.trim()} type="submit">
        {starting ? "Starting scan…" : "Start tester scan"}
      </button>
    </div>
    {message && <p className={failed ? "error-text" : ""} role={failed ? "alert" : "status"}>{message}</p>}
  </form>;
}

function LoginGate() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void request("/api/auth/session").then(() => { if (active) setAuthenticated(true); }).catch(() => { if (active) setAuthenticated(false); });
    const expired = () => { setAuthenticated(false); setError("Your session ended. Please sign in again."); };
    window.addEventListener("session-expired", expired);
    return () => { active = false; window.removeEventListener("session-expired", expired); };
  }, []);
  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      setPassword(""); setAuthenticated(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Login failed"); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { await request("/api/auth/logout", { method: "POST" }); setAuthenticated(false); setError(""); }
    catch (cause) { window.alert(cause instanceof Error ? cause.message : "Logout failed"); }
  }
  if (authenticated) return <App onLogout={() => void logout()} />;
  return <main className="login-page"><section className="login-card">
    <div className="eyebrow">FARM / CONTROL ROOM</div><h1>Welcome back</h1>
    <p>Sign in to manage your workers and settings.</p>
    {authenticated === null ? <p role="status">Checking your session…</p> : <form onSubmit={login}>
      <label htmlFor="login-username">Username<input id="login-username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label htmlFor="login-password">Password<input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
    </form>}
  </section></main>;
}

function App({ onLogout }: { onLogout: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({});
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<View>("agents");
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [search, setSearch] = useState("");
  const [connection, setConnection] = useState<"live" | "reconnecting">("reconnecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const workers = await request<Agent[]>("/api/agents");
        if (!active) return;
        setAgents(workers);
        const histories = await Promise.all(workers.map(async worker => [worker.workerId, await request<AgentEvent[]>(`/api/agents/${worker.workerId}/events`)] as const));
        if (active) {
          setEvents(current => {
            const merged = { ...current };
            for (const [id, history] of histories) {
              merged[id] = [...new Map([...(current[id] ?? []), ...history].map(event => [event.id, event])).values()].sort((a, b) => a.id - b.id);
            }
            return merged;
          });
          setHasOlder(current => ({ ...Object.fromEntries(histories.map(([id, history]) => [id, history.length >= 300])), ...current }));
        }
        setError("");
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    }
    void refresh();
    void request<Config>("/api/settings").then(value => { if (active) setConfig(value); }).catch(cause => { if (active) setError(String(cause)); });
    const timer = window.setInterval(refresh, 5000);
    const stream = new EventSource("/api/events");
    stream.onopen = () => { setConnection("live"); void refresh(); };
    stream.onerror = () => setConnection("reconnecting");
    stream.onmessage = message => {
      const event = JSON.parse(message.data) as AgentEvent;
      setEvents(current => {
        const previous = current[event.workerId] ?? [];
        if (previous.some(item => item.id === event.id)) return current;
        return { ...current, [event.workerId]: [...previous, event] };
      });
    };
    return () => { active = false; window.clearInterval(timer); stream.close(); };
  }, []);

  const visible = useMemo(() => agents.filter(agent =>
    (filter === "all" || !agent.archived) &&
    `${agent.role} ${agent.agentId} ${agent.root ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ).sort((a, b) => Number(b.status === "working") - Number(a.status === "working")), [agents, filter, search]);
  const activeCount = agents.filter(agent => !agent.archived).length;
  const workingCount = agents.filter(agent => !agent.archived && agent.status === "working").length;

  async function loadOlder(workerId: string) {
    const before = events[workerId]?.[0]?.id;
    if (!before) return;
    try {
      const history = await request<AgentEvent[]>(`/api/agents/${workerId}/events?before=${before}`);
      setEvents(current => ({ ...current, [workerId]: [...history, ...(current[workerId] ?? [])] }));
      setHasOlder(current => ({ ...current, [workerId]: history.length >= 300 }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">F<span>·</span></div><div><strong>FARM</strong><small>CONTROL ROOM</small></div></div>
      <nav><button className={view === "agents" ? "nav-item selected" : "nav-item"} onClick={() => setView("agents")}><span>▦</span> Agents <b>{activeCount}</b></button><button className={view === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setView("settings")}><span>⚙</span> Settings</button></nav>
      <div className="sidebar-spacer" />
      <button type="button" className="secondary-button" onClick={onLogout}>Sign out</button>
      <div className="sidebar-status"><span className={`connection-dot ${connection}`} /><div><strong>{connection === "live" ? "Connected" : "Reconnecting"}</strong><small>Live event stream</small></div></div>
      <div className="sidebar-foot">AUTO WORKER <span>v1.0</span></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="breadcrumbs">WORKSPACE <span>/</span> {view === "agents" ? "AGENTS" : "SETTINGS"}</div><div className="topbar-right"><span className="topbar-live"><i /> LIVE MONITORING</span><span className="topbar-date">{new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div></header>
      <div className="content">
        {error && <div className="error-banner">{error}</div>}
        {view === "agents" ? <>
          <StartTesterScan />
          <div className="hero"><div><div className="eyebrow">OPERATIONS OVERVIEW</div><h1>Agent activity<span className="heading-dot">.</span></h1><p>Follow each agent’s prompts, progress, and output as work happens.</p></div><div className="hero-metrics"><div><strong>{activeCount}</strong><span>ACTIVE AGENTS</span></div><div><strong>{workingCount}</strong><span>WORKING NOW</span></div><div><strong>{agents.length - activeCount}</strong><span>COMPLETED</span></div></div></div>
          <div className="toolbar"><div className="segment"><button className={filter === "active" ? "chosen" : ""} onClick={() => setFilter("active")}>Active</button><button className={filter === "all" ? "chosen" : ""} onClick={() => setFilter("all")}>All agents</button></div><div className="search-wrap"><span>⌕</span><input aria-label="Search agents" placeholder="Search agents or workspaces" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
          {visible.length ? <div className="agent-grid">{visible.map(agent => <AgentWindow key={agent.workerId} agent={agent} events={events[agent.workerId] ?? []} hasOlder={hasOlder[agent.workerId] ?? false} loadOlder={() => void loadOlder(agent.workerId)} />)}</div> : <div className="empty-state"><div>◇</div><h3>No agents in this view</h3><p>Agents appear here when webhooks assign work to coders, reviewers, or testers.</p></div>}
        </> : config && <SettingsEditor config={config} onSaved={setConfig} />}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><LoginGate /></React.StrictMode>);
