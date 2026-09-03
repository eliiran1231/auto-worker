import { formatTemplate } from "../utils/templates.js";
import { settings } from "../settings.js";
import { Worker } from "../classes/Worker.js";

export class Coder extends Worker {
    solveIssue(issue: any): Promise<number> {
        return this.spawn(
            formatTemplate(settings.prompts.workOnIssue, {
                issueUrl: issue.url,
            }),
        );
    }

    addressReview(pullRequest: any): Promise<number> {
        return this.send(
            formatTemplate(settings.prompts.addressReview, {
                pullRequestUrl: pullRequest.url,
            }),
        );
    }
}