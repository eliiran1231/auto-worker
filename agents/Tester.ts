import { Octokit } from "octokit";
import { Worker } from "../classes/Worker.js";
import type { WorkerType } from "../classes/Worker.js";
import { getGitHubToken } from "../utils/github.js";
import { settings } from "../settings.js";
import type { Repository } from "../interfaces/Repository.js";
import type { WorkflowRun } from "../types/WorkflowRun.js";
import { WorkflowManager } from "../classes/workflowManager.js";
import { formatTemplate } from "../utils/templates.js";


export class Tester extends Worker {
    constructor(type: WorkerType, root?: string) {
        super(type, root, "tester");
    }

    findBugs(): Promise<number> {
        return this.spawn(settings.prompts.findBugs);
    }

    private async triggerTestWorkflow(
        repo: Repository,
        workflowId: string,
        branch: string
    ) {
        const octokit = new Octokit({ auth: getGitHubToken("tester") });
        const owner = settings.github.username;
        const ref = branch;

        const response = await octokit.request(
            "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
            {
            owner,
            repo: repo.name,
            workflow_id: workflowId,
            ref,
            return_run_details: true,
            headers: {
                "X-GitHub-Api-Version": "2026-03-10",
            },
            },
        );

        return response.data.workflow_run_id;
    }

    private async waitForWorkflowCompletion(repo: Repository, workflowRunId: number) {
        return new Promise<WorkflowRun>((resolve) => {
            const subscription = WorkflowManager.getWorkflowRunCompletedReplaySubject(repo)
            .subscribe((workflowRun) => {
                if (workflowRun.id === workflowRunId) {
                    subscription.unsubscribe();
                    resolve(workflowRun);
                }
            });
        });
    }

    async runTest(
        repo: Repository,
        workflowId: string,
        branch: string
    ) {
        const workflow_run_id = await this.triggerTestWorkflow(repo, workflowId, branch);
        const workflowRun = await this.waitForWorkflowCompletion(repo, Number(workflow_run_id));
        return workflowRun;
    }

    analyzeTestResultsAndCreateIssues(testResult: WorkflowRun): Promise<number> {
        return this.send(
            formatTemplate(settings.prompts.analyzeTestResultsAndCreateIssues, {
                testResultUrl: testResult.html_url,
            }),
        );
    }

    writeTests(): Promise<number> {
        return this.spawn(settings.prompts.writeTests);
    }
}
