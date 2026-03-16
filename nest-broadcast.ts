/**
 * Nest broadcast integration for subagent visibility.
 *
 * When running inside a Nest session (NEST_URL + SERVER_TOKEN + NEST_SESSION env vars),
 * this module broadcasts subagent lifecycle events to the parent session's Discord channel
 * via Nest's /api/block HTTP endpoint.
 *
 * Events:
 * - subagent:start  → "🔍 Scout starting: {task summary}"
 * - subagent:tool   → periodic tool activity updates (debounced)
 * - subagent:done   → "✅ Scout completed (12s)" or "❌ Scout failed (12s)"
 */

import * as http from "node:http";

// ─── Configuration ───────────────────────────────────────

const NEST_URL = process.env.NEST_URL;
const SERVER_TOKEN = process.env.SERVER_TOKEN;
const NEST_SESSION = process.env.NEST_SESSION;

/** Whether we're running inside Nest and can broadcast */
export const isNestEnabled = Boolean(NEST_URL && SERVER_TOKEN && NEST_SESSION);

/** Max length for task summary in start messages */
const TASK_SUMMARY_MAX = 200;

/** Minimum interval between tool activity broadcasts per agent (ms) */
const TOOL_BROADCAST_INTERVAL_MS = 8_000;

/** Agent display names and icons */
const AGENT_DISPLAY: Record<string, { icon: string; name: string }> = {
	scout: { icon: "🔍", name: "Scout" },
	worker: { icon: "🔧", name: "Worker" },
	planner: { icon: "📋", name: "Planner" },
	"task-runner": { icon: "⚙️", name: "Task Runner" },
	"context-gatherer": { icon: "📚", name: "Context Gatherer" },
	reviewer: { icon: "🔎", name: "Reviewer" },
};

const DEFAULT_DISPLAY = { icon: "🤖", name: "Agent" };

// ─── Internal State ──────────────────────────────────────

let blockCounter = 0;
const lastToolBroadcast = new Map<string, number>();

// ─── Helpers ─────────────────────────────────────────────

function getDisplay(agentName: string): { icon: string; name: string } {
	return AGENT_DISPLAY[agentName] ?? { ...DEFAULT_DISPLAY, name: agentName };
}

function truncateTask(task: string): string {
	// Take first line or first N chars, whichever is shorter
	const firstLine = task.split("\n")[0]?.trim() ?? task.trim();
	if (firstLine.length <= TASK_SUMMARY_MAX) return firstLine;
	return firstLine.slice(0, TASK_SUMMARY_MAX - 3) + "...";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainSecs = secs % 60;
	return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

/**
 * POST a display block to Nest's /api/block endpoint.
 * Fire-and-forget — errors are silently ignored.
 */
function postBlock(fallback: string): void {
	if (!isNestEnabled) return;

	const blockId = `subagent-${Date.now()}-${++blockCounter}`;
	const body = JSON.stringify({
		session: NEST_SESSION,
		block: {
			id: blockId,
			kind: "markdown",
			data: { text: fallback },
			fallback,
		},
	});

	try {
		const url = new URL("/api/block", NEST_URL);
		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					Authorization: `Bearer ${SERVER_TOKEN}`,
				},
				timeout: 3000,
			},
			(res) => {
				// Drain response
				res.resume();
			},
		);
		req.on("error", () => {}); // Silently ignore
		req.write(body);
		req.end();
	} catch {
		// Silently ignore — don't break subagent execution
	}
}

// ─── Public API ──────────────────────────────────────────

/**
 * Broadcast that a subagent is starting.
 */
export function broadcastStart(agentName: string, task: string, index?: number, total?: number): void {
	if (!isNestEnabled) return;

	const { icon, name } = getDisplay(agentName);
	const taskSummary = truncateTask(task);
	const indexLabel = total && total > 1 ? ` [${(index ?? 0) + 1}/${total}]` : "";

	postBlock(`${icon} **${name}**${indexLabel} starting: ${taskSummary}`);
}

/**
 * Broadcast tool activity for a running subagent (debounced).
 */
export function broadcastToolActivity(agentName: string, toolName: string, toolCount: number, index?: number, total?: number): void {
	if (!isNestEnabled) return;

	const key = `${agentName}-${index ?? 0}`;
	const now = Date.now();
	const last = lastToolBroadcast.get(key) ?? 0;

	if (now - last < TOOL_BROADCAST_INTERVAL_MS) return;
	lastToolBroadcast.set(key, now);

	const { icon, name } = getDisplay(agentName);
	const indexLabel = total && total > 1 ? ` [${(index ?? 0) + 1}/${total}]` : "";

	postBlock(`${icon} **${name}**${indexLabel} → \`${toolName}\` (${toolCount} tools used)`);
}

/**
 * Broadcast that a subagent completed.
 */
export function broadcastComplete(agentName: string, exitCode: number, durationMs: number, error?: string, index?: number, total?: number): void {
	if (!isNestEnabled) return;

	const { icon: _, name } = getDisplay(agentName);
	const duration = formatDuration(durationMs);
	const indexLabel = total && total > 1 ? ` [${(index ?? 0) + 1}/${total}]` : "";

	// Clean up debounce state
	const key = `${agentName}-${index ?? 0}`;
	lastToolBroadcast.delete(key);

	if (exitCode === 0) {
		postBlock(`✅ **${name}**${indexLabel} completed (${duration})`);
	} else {
		const errorSuffix = error ? `: ${truncateTask(error)}` : "";
		postBlock(`❌ **${name}**${indexLabel} failed (${duration})${errorSuffix}`);
	}
}

/**
 * Broadcast a chain step starting.
 */
export function broadcastChainStep(stepIndex: number, totalSteps: number, agentName: string, task: string): void {
	if (!isNestEnabled) return;

	const { icon, name } = getDisplay(agentName);
	const taskSummary = truncateTask(task);

	postBlock(`${icon} **${name}** (step ${stepIndex + 1}/${totalSteps}): ${taskSummary}`);
}

/**
 * Broadcast parallel execution starting.
 */
export function broadcastParallelStart(tasks: Array<{ agent: string; task: string }>): void {
	if (!isNestEnabled) return;

	const lines = tasks.map((t, i) => {
		const { icon, name } = getDisplay(t.agent);
		return `  ${i + 1}. ${icon} **${name}**: ${truncateTask(t.task)}`;
	});

	postBlock(`⚡ Running **${tasks.length} agents** in parallel:\n${lines.join("\n")}`);
}

/**
 * Broadcast overall parallel execution complete.
 */
export function broadcastParallelComplete(succeeded: number, total: number, durationMs: number): void {
	if (!isNestEnabled) return;

	const duration = formatDuration(durationMs);
	const allOk = succeeded === total;
	const icon = allOk ? "✅" : "⚠️";

	postBlock(`${icon} Parallel execution complete: **${succeeded}/${total}** succeeded (${duration})`);
}
