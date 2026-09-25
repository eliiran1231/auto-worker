import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { WorkerRole } from "../types/WorkerRole.js";
import type { WorkerStatus, WorkerType } from "./Worker.js";
import type { Repository } from "../interfaces/Repository.js";
import type { WorkflowRun } from "../types/WorkflowRun.js";

export interface AgentEvent {
  id: number;
  workerId: string;
  kind: "prompt" | "output" | "status" | "activity";
  message: string;
  createdAt: string;
}

export interface SavedScan {
  repository: Repository;
  branch: string;
  phase: "writing" | "testing" | "analyzing";
  workflowRun?: WorkflowRun;
}

export interface SavedWorker {
  role: WorkerRole;
  agentId: string;
  workerId: string;
  type: WorkerType;
  root: string | null;
  initialized: boolean;
  status: WorkerStatus;
  conversationId: string | null;
  pending: string[];
  archived?: boolean;
}

export class WorkerStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workers (
      role TEXT NOT NULL, agent_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      type TEXT NOT NULL, root TEXT, initialized INTEGER NOT NULL,
      status TEXT NOT NULL, conversation_id TEXT, pending TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (role, agent_id)
    )`);
    const columns = this.db.prepare("PRAGMA table_info(workers)").all() as { name: string }[];
    if (!columns.some(column => column.name === "archived")) {
      this.db.exec("ALTER TABLE workers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS tester_scans (
      repository_id INTEGER PRIMARY KEY, state TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL,
      kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_events_worker ON agent_events(worker_id, id)");
  }

  save(worker: SavedWorker): void {
    this.db.prepare(`INSERT INTO workers (role, agent_id, worker_id, type, root, initialized, status, conversation_id, pending, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(role, agent_id) DO UPDATE SET
      worker_id=excluded.worker_id, type=excluded.type, root=excluded.root,
      initialized=excluded.initialized, status=excluded.status,
      conversation_id=excluded.conversation_id, pending=excluded.pending, archived=0`).run(
      worker.role, worker.agentId, worker.workerId, worker.type, worker.root,
      Number(worker.initialized), worker.status, worker.conversationId,
      JSON.stringify(worker.pending),
    );
  }

  load(includeArchived = false): SavedWorker[] {
    const rows = this.db.prepare(includeArchived ? "SELECT * FROM workers" : "SELECT * FROM workers WHERE archived = 0").all();
    return (rows as Record<string, unknown>[]).map(row => ({
      role: row.role as WorkerRole,
      agentId: row.agent_id as string,
      workerId: row.worker_id as string,
      type: row.type as WorkerType,
      root: row.root as string | null,
      initialized: Boolean(row.initialized),
      status: row.status as WorkerStatus,
      conversationId: row.conversation_id as string | null,
      pending: JSON.parse(row.pending as string) as string[],
      archived: Boolean(row.archived),
    }));
  }

  delete(role: WorkerRole, agentId: string): void {
    this.db.prepare("UPDATE workers SET archived = 1, status = 'idle', pending = '[]' WHERE role = ? AND agent_id = ?").run(role, agentId);
  }

  saveScan(scan: SavedScan): void {
    this.db.prepare(`INSERT INTO tester_scans VALUES (?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET state=excluded.state`).run(
      scan.repository.id, JSON.stringify(scan),
    );
  }

  loadScans(): SavedScan[] {
    return (this.db.prepare("SELECT state FROM tester_scans").all() as { state: string }[])
      .map(row => JSON.parse(row.state) as SavedScan);
  }

  deleteScan(repositoryId: number): void {
    this.db.prepare("DELETE FROM tester_scans WHERE repository_id = ?").run(repositoryId);
  }

  appendEvent(workerId: string, kind: AgentEvent["kind"], message: string): AgentEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO agent_events (worker_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
      .run(workerId, kind, message, createdAt);
    const event = { id: Number(result.lastInsertRowid), workerId, kind, message, createdAt };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  events(workerId: string, afterId = 0, limit = 300): AgentEvent[] {
    return (this.db.prepare(`SELECT id, worker_id AS workerId, kind, message, created_at AS createdAt
      FROM agent_events WHERE worker_id = ? AND id > ? ORDER BY id DESC LIMIT ?`)
      .all(workerId, afterId, limit) as unknown as AgentEvent[]).reverse();
  }

  olderEvents(workerId: string, beforeId: number, limit = 300): AgentEvent[] {
    return (this.db.prepare(`SELECT id, worker_id AS workerId, kind, message, created_at AS createdAt
      FROM agent_events WHERE worker_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(workerId, beforeId, limit) as unknown as AgentEvent[]).reverse();
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void { this.db.close(); }
}
