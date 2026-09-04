import { ReplaySubject } from "rxjs";
import type { WorkflowRun } from "../types/WorkflowRun.js";
import type { Repository } from "../interfaces/Repository.js";

export class WorkflowManager {
    private static onWorkflowRunCompleted: Record<string, ReplaySubject<WorkflowRun> | undefined> = {};
    static notifyWorkflowRunCompleted(repo: Repository, workflowRun: WorkflowRun) {
        const run = WorkflowManager.getWorkflowRunCompletedReplaySubject(repo);
        if (run) run.next(workflowRun);
    }
    static getWorkflowRunCompletedReplaySubject(repo: Repository): ReplaySubject<WorkflowRun> {
        this.onWorkflowRunCompleted[repo.name] ??= new ReplaySubject<WorkflowRun>();
        return this.onWorkflowRunCompleted[repo.name]!;
    }
}
