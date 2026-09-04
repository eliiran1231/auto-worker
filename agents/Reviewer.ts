import { settings } from "../settings.js";
import { formatTemplate } from "../utils/templates.js";
import { Worker } from "../classes/Worker.js";
import type { WorkerType } from "../classes/Worker.js";
export class Reviewer extends Worker {
    constructor(type: WorkerType, root?: string) {
        super(type, root, "reviewer");
    }

    reviewPullRequest(pullRequest: any): Promise<number> {
        return this.spawn(
            formatTemplate(settings.prompts.reviewPullRequest, {
                pullRequestUrl: pullRequest.url,
            }),
        );
    }

    reReviewPullRequest(pullRequest: any): Promise<number> {
        return this.send(
            formatTemplate(settings.prompts.reReviewPullRequest, {
                pullRequestUrl: pullRequest.url,
            }),
        );
    }
}
