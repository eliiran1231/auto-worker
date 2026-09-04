import { Subject } from "rxjs";
import type { WorkflowRun } from "../types/WorkflowRun.js";
import type { Repository } from "../interfaces/Repository.js";

export class WorkflowManager {
    private static onWorkflowRunCompleted: Record<string, Subject<WorkflowRun>> = {};
    static notifyWorkflowRunCompleted(repo: Repository, workflowRun: WorkflowRun) {
        if (this.onWorkflowRunCompleted[repo.name]) {
            this.onWorkflowRunCompleted[repo.name].next(workflowRun);
        }
    }
    static getWorkflowRunCompletedSubject(repo: Repository): Subject<WorkflowRun> {
        this.onWorkflowRunCompleted[repo.name] ??= new Subject<WorkflowRun>();
        return this.onWorkflowRunCompleted[repo.name];
    }
}
