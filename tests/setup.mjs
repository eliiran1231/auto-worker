import { settings } from "../settings.ts";

// Tests must not send alerts using the developer's live SMTP configuration.
// Email-specific tests enable notifications with a mocked transport.
settings.email.enabled = false;
