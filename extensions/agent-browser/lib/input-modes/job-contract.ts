import type { AgentBrowserJobStepAction } from "./types.js";

export const JOB_STEP_ALLOWED_FIELDS: Record<AgentBrowserJobStepAction, readonly string[]> = {
	assertText: ["action", "text"],
	assertUrl: ["action", "url"],
	click: ["action", "locator", "name", "role", "selector", "value"],
	fill: ["action", "locator", "name", "role", "selector", "text", "value"],
	open: ["action", "loadState", "url"],
	screenshot: ["action", "path"],
	select: ["action", "selector", "value", "values"],
	snapshot: ["action"],
	type: ["action", "delayMs", "press", "selector", "text"],
	wait: ["action", "milliseconds"],
	waitForDownload: ["action", "path"],
};
