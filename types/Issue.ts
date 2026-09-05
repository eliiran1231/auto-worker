import type { IssueAssignedEvent } from "./IssueAssignedEvent.js";

export type Issue = IssueAssignedEvent["payload"]["issue"];
