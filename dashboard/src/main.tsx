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
type Config = Record<string, Record<string, string | number>>;
type View = "agents" | "settings";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

function shortPath(value: string | null) {
  return value?.replaceAll("\\", "/").split("/").slice(-2).join("/") ?? "No workspace";
}

function AgentWindow({ agent, events, hasOlder, loadOlder }: { agent: Agent; events: AgentEvent[]; hasOlder: boolean; loadOlder: () => void }) {
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
    <div className="window-footer"><span>LIVE FEED</span><span>{events.length} events</span></div>
  </section>;
}

function SettingsEditor({ config, onSaved }: { config: Config; onSaved: (next: Config) => void }) {
  const [draft, setDraft] = useState<Config>(() => structuredClone(config));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  useEffect(() => { setDraft(structuredClone(config)); }, [config]);

  function change(section: string, key: string, value: string | number) {
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
    {Object.entries(draft).map(([section, values]) => <section className="settings-card" key={section}>
      <div className="settings-card-head"><span className="settings-section-icon">{section.slice(0, 1).toUpperCase()}</span><div><h3>{section}</h3><p>{section === "server" ? "Listener settings are shown for reference and require a restart." : "Applied to the running server when saved."}</p></div></div>
      <div className="settings-fields">{Object.entries(values).map(([key, value]) => <label className={section === "prompts" || section === "queries" ? "wide-field" : ""} key={key}>
        <span>{key.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase())}</span>
        {section === "prompts" || section === "queries"
          ? <textarea value={value} disabled={section === "server"} rows={section === "prompts" ? 4 : 3} onChange={event => change(section, key, event.target.value)} />
          : section === "agents"
            ? <select value={value} onChange={event => change(section, key, event.target.value)}><option value="codex">codex</option><option value="claude">claude</option></select>
            : <input value={value} type={typeof value === "number" ? "number" : "text"} disabled={section === "server"} onChange={event => change(section, key, typeof value === "number" ? Number(event.target.value) : event.target.value)} />}
      </label>)}</div>
    </section>)}
    <div className="save-bar"><span className={message && !message.startsWith("Settings saved") ? "error-text" : ""}>{message || (dirty ? "Unsaved changes" : "All changes saved")}</span><div><button className="secondary-button" disabled={!dirty || saving} onClick={() => setDraft(structuredClone(config))}>Reset</button><button className="primary-button" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save settings"}</button></div></div>
  </div>;
}

function App() {
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
      <div className="sidebar-status"><span className={`connection-dot ${connection}`} /><div><strong>{connection === "live" ? "Connected" : "Reconnecting"}</strong><small>Live event stream</small></div></div>
      <div className="sidebar-foot">AUTO WORKER <span>v1.0</span></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="breadcrumbs">WORKSPACE <span>/</span> {view === "agents" ? "AGENTS" : "SETTINGS"}</div><div className="topbar-right"><span className="topbar-live"><i /> LIVE MONITORING</span><span className="topbar-date">{new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div></header>
      <div className="content">
        {error && <div className="error-banner">{error}</div>}
        {view === "agents" ? <>
          <div className="hero"><div><div className="eyebrow">OPERATIONS OVERVIEW</div><h1>Agent activity<span className="heading-dot">.</span></h1><p>Follow each agent’s prompts, progress, and output as work happens.</p></div><div className="hero-metrics"><div><strong>{activeCount}</strong><span>ACTIVE AGENTS</span></div><div><strong>{workingCount}</strong><span>WORKING NOW</span></div><div><strong>{agents.length - activeCount}</strong><span>COMPLETED</span></div></div></div>
          <div className="toolbar"><div className="segment"><button className={filter === "active" ? "chosen" : ""} onClick={() => setFilter("active")}>Active</button><button className={filter === "all" ? "chosen" : ""} onClick={() => setFilter("all")}>All agents</button></div><div className="search-wrap"><span>⌕</span><input aria-label="Search agents" placeholder="Search agents or workspaces" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
          {visible.length ? <div className="agent-grid">{visible.map(agent => <AgentWindow key={agent.workerId} agent={agent} events={events[agent.workerId] ?? []} hasOlder={hasOlder[agent.workerId] ?? false} loadOlder={() => void loadOlder(agent.workerId)} />)}</div> : <div className="empty-state"><div>◇</div><h3>No agents in this view</h3><p>Agents appear here when webhooks assign work to coders, reviewers, or testers.</p></div>}
        </> : config && <SettingsEditor config={config} onSaved={setConfig} />}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
