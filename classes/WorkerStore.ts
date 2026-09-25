import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { WorkerRole } from "../types/WorkerRole.js";
import type { WorkerStatus, WorkerType } from "./Worker.js";
import type { Repository } from "../interfaces/Repository.js";
import type { WorkflowRun } from "../types/WorkflowRun.js";

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
}

export class WorkerStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workers (
      role TEXT NOT NULL, agent_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      type TEXT NOT NULL, root TEXT, initialized INTEGER NOT NULL,
      status TEXT NOT NULL, conversation_id TEXT, pending TEXT NOT NULL,
      PRIMARY KEY (role, agent_id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tester_scans (
      repository_id INTEGER PRIMARY KEY, state TEXT NOT NULL
    )`);
  }

  save(worker: SavedWorker): void {
    this.db.prepare(`INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role, agent_id) DO UPDATE SET
      worker_id=excluded.worker_id, type=excluded.type, root=excluded.root,
      initialized=excluded.initialized, status=excluded.status,
      conversation_id=excluded.conversation_id, pending=excluded.pending`).run(
      worker.role, worker.agentId, worker.workerId, worker.type, worker.root,
      Number(worker.initialized), worker.status, worker.conversationId,
      JSON.stringify(worker.pending),
    );
  }

  load(): SavedWorker[] {
    return (this.db.prepare("SELECT * FROM workers").all() as Record<string, unknown>[]).map(row => ({
      role: row.role as WorkerRole,
      agentId: row.agent_id as string,
      workerId: row.worker_id as string,
      type: row.type as WorkerType,
      root: row.root as string | null,
      initialized: Boolean(row.initialized),
      status: row.status as WorkerStatus,
      conversationId: row.conversation_id as string | null,
      pending: JSON.parse(row.pending as string) as string[],
    }));
  }

  delete(role: WorkerRole, agentId: string): void {
    this.db.prepare("DELETE FROM workers WHERE role = ? AND agent_id = ?").run(role, agentId);
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

  close(): void { this.db.close(); }
}
