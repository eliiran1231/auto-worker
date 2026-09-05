import { Octokit } from "octokit";
import { filter, firstValueFrom, timeout } from "rxjs";
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

    private async triggerTestWorkflow(
        repo: Repository,
        workflowId: string,
        branch: string
    ) {
        const octokit = new Octokit({ auth: getGitHubToken("tester") });
        const owner = repo.owner.login;
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

        const workflowRunId = Number(response.data.workflow_run_id);
        if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
            throw new Error("Workflow dispatch did not return a valid workflow run ID");
        }
        return workflowRunId;
    }

    private async waitForWorkflowCompletion(repo: Repository, workflowRunId: number) {
        return firstValueFrom(
            WorkflowManager.getWorkflowRunCompletedReplaySubject(repo).pipe(
                filter((workflowRun) => workflowRun.id === workflowRunId),
                timeout({ first: settings.tests.workflowTimeoutMs }),
            ),
        );
    }

    async runTest(
        repo: Repository,
        workflowId: string,
        branch: string
    ) {
        const workflow_run_id = await this.triggerTestWorkflow(repo, workflowId, branch);
        const workflowRun = await this.waitForWorkflowCompletion(repo, workflow_run_id);
        return workflowRun;
    }

    analyzeTestResultsAndCreateIssues(testResult: WorkflowRun): Promise<number> {
        return this.send(
            formatTemplate(settings.prompts.analyzeTestResultsAndCreateIssues, {
                testResultUrl: testResult.url,
            }),
        );
    }

    writeTests(): Promise<number> {
        return this.spawn(settings.prompts.writeTests);
    }
    continueWritingTests() {
      return this.send(settings.prompts.continueWritingTests);
    }
}
