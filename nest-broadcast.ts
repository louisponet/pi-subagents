/**
 * Nest broadcast integration for subagent visibility.
 *
 * When running inside a Nest session (NEST_URL + SERVER_TOKEN + NEST_SESSION env vars),
 * this module creates ONE persistent Discord message per subtask and EDITS it in-place
 * as the agent progresses. No message spam — just live-updating status cards.
 *
 * Each status message shows:
 * - Color-coded status indicator (🟡 running, ✅ completed, ❌ failed)
 * - Agent type, task summary, progress info
 * - Current tool being used
 * - Last 2 meaningful outputs from the agent
 * - Duration and token usage
 *
 * Uses Nest's /api/block for initial create and /api/block/update for edits.
 * The Discord plugin tracks blockId → Discord messageId for in-place editing.
 */

import * as http from "node:http";

// ─── Configuration ───────────────────────────────────────

const NEST_URL = process.env.NEST_URL;
const SERVER_TOKEN = process.env.SERVER_TOKEN;
const NEST_SESSION = process.env.NEST_SESSION;

/** Whether we're running inside Nest and can broadcast */
export const isNestEnabled = Boolean(NEST_URL && SERVER_TOKEN && NEST_SESSION);

/** Max length for task summary */
const TASK_SUMMARY_MAX = 120;

/** Max characters for each recent output line */
const OUTPUT_LINE_MAX = 150;

/** Minimum interval between status updates per agent (ms) */
const UPDATE_INTERVAL_MS = 3_000;

/** Agent display names */
const AGENT_NAMES: Record<string, string> = {
	scout: "Scout",
	worker: "Worker",
	planner: "Planner",
	"task-runner": "Task Runner",
	"context-gatherer": "Context Gatherer",
	reviewer: "Reviewer",
};

// ─── Internal State ──────────────────────────────────────

let blockCounter = 0;

/** Track per-agent block IDs and last update time */
interface AgentBlock {
	blockId: string;
	lastUpdate: number;
	created: boolean; // whether the initial block has been sent
}
const agentBlocks = new Map<string, AgentBlock>();

// ─── Helpers ─────────────────────────────────────────────

function getAgentName(agentName: string): string {
	return AGENT_NAMES[agentName] ?? agentName;
}

function agentKey(agentName: string, index?: number): string {
	return `${agentName}-${index ?? 0}`;
}

function truncate(text: string, max: number): string {
	const firstLine = text.split("\n")[0]?.trim() ?? text.trim();
	if (firstLine.length <= max) return firstLine;
	return firstLine.slice(0, max - 1) + "…";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainSecs = secs % 60;
	return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Get the last N meaningful output lines, cleaned up */
function getRecentOutputLines(recentOutput: string[], count: number): string[] {
	// Filter out empty/whitespace-only lines and very short filler
	const meaningful = recentOutput.filter(
		(line) => line.trim().length > 5 && !line.startsWith("---") && !line.startsWith("```"),
	);
	return meaningful.slice(-count).map((line) => truncate(line, OUTPUT_LINE_MAX));
}

// ─── Status Message Builder ──────────────────────────────

interface StatusInfo {
	agentName: string;
	status: "running" | "completed" | "failed";
	task: string;
	index?: number;
	total?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolArgs?: string;
	durationMs?: number;
	tokens?: number;
	recentOutput?: string[];
	error?: string;
}

function buildStatusMessage(info: StatusInfo): string {
	const { icon, name } = getDisplay(info.agentName);
	const indexLabel = info.total && info.total > 1 ? ` [${(info.index ?? 0) + 1}/${info.total}]` : "";

	// Status indicator
	let statusIcon: string;
	let statusText: string;
	switch (info.status) {
		case "running":
			statusIcon = "🟡";
			statusText = "Running";
			break;
		case "completed":
			statusIcon = "✅";
			statusText = "Completed";
			break;
		case "failed":
			statusIcon = "❌";
			statusText = "Failed";
			break;
	}

	// Header
	const header = `${statusIcon} ${icon} **${name}**${indexLabel} — ${statusText}`;

	// Task summary
	const taskLine = `> ${truncate(info.task, TASK_SUMMARY_MAX)}`;

	// Stats line
	const stats: string[] = [];
	if (info.durationMs != null && info.durationMs > 0) {
		stats.push(`⏱ ${formatDuration(info.durationMs)}`);
	}
	if (info.toolCount != null && info.toolCount > 0) {
		stats.push(`🔨 ${info.toolCount} tools`);
	}
	if (info.tokens != null && info.tokens > 0) {
		stats.push(`📊 ${formatTokens(info.tokens)} tokens`);
	}

	// Current tool
	let toolLine = "";
	if (info.status === "running" && info.currentTool) {
		const argsPreview = info.currentToolArgs ? ` ${truncate(info.currentToolArgs, 60)}` : "";
		toolLine = `\n🔧 \`${info.currentTool}\`${argsPreview}`;
	}

	// Recent outputs (last 2 meaningful lines)
	let outputSection = "";
	if (info.recentOutput && info.recentOutput.length > 0) {
		const lines = getRecentOutputLines(info.recentOutput, 2);
		if (lines.length > 0) {
			const outputLines = lines.map((l) => `> ${l}`).join("\n");
			outputSection = `\n📝 **Recent:**\n${outputLines}`;
		}
	}

	// Error info
	let errorSection = "";
	if (info.error) {
		errorSection = `\n⚠️ ${truncate(info.error, 200)}`;
	}

	// Compose message
	const parts = [header, taskLine];
	if (stats.length > 0) parts.push(stats.join("  ·  "));
	if (toolLine) parts.push(toolLine);
	if (outputSection) parts.push(outputSection);
	if (errorSection) parts.push(errorSection);

	return parts.join("\n");
}

// ─── HTTP Transport ──────────────────────────────────────

function nestRequest(path: string, body: Record<string, unknown>): Promise<void> {
	if (!isNestEnabled) return Promise.resolve();

	return new Promise((resolve) => {
		try {
			const payload = JSON.stringify(body);
			const url = new URL(path, NEST_URL);
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port,
					path: url.pathname,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(payload),
						Authorization: `Bearer ${SERVER_TOKEN}`,
					},
					timeout: 5000,
				},
				(res) => {
					res.resume();
					resolve();
				},
			);
			req.on("error", () => resolve());
			req.on("timeout", () => {
				req.destroy();
				resolve();
			});
			req.write(payload);
			req.end();
		} catch {
			resolve();
		}
	});
}

/** Create a new block (initial message) */
function createBlock(blockId: string, text: string): Promise<void> {
	return nestRequest("/api/block", {
		session: NEST_SESSION,
		block: {
			id: blockId,
			kind: "markdown",
			data: { text },
			fallback: text,
		},
	});
}

/** Update an existing block (edit message in-place) */
function updateBlock(blockId: string, text: string): Promise<void> {
	return nestRequest("/api/block/update", {
		session: NEST_SESSION,
		id: blockId,
		data: { text },
		fallback: text,
	});
}

/** Remove a block */
function removeBlock(blockId: string): Promise<void> {
	return nestRequest("/api/block/remove", {
		session: NEST_SESSION,
		id: blockId,
	});
}

// ─── Block Management ────────────────────────────────────

function getOrCreateBlockId(key: string): string {
	const existing = agentBlocks.get(key);
	if (existing) return existing.blockId;
	const blockId = `sa-${Date.now()}-${++blockCounter}`;
	agentBlocks.set(key, { blockId, lastUpdate: 0, created: false });
	return blockId;
}

function shouldThrottle(key: string): boolean {
	const block = agentBlocks.get(key);
	if (!block) return false;
	return Date.now() - block.lastUpdate < UPDATE_INTERVAL_MS;
}

function markUpdated(key: string): void {
	const block = agentBlocks.get(key);
	if (block) block.lastUpdate = Date.now();
}

async function sendOrUpdate(key: string, text: string): Promise<void> {
	const block = agentBlocks.get(key);
	if (!block) return;

	if (!block.created) {
		await createBlock(block.blockId, text);
		block.created = true;
	} else {
		await updateBlock(block.blockId, text);
	}
	block.lastUpdate = Date.now();
}

// ─── Public API ──────────────────────────────────────────

/**
 * Broadcast that a subagent is starting. Creates the persistent status message.
 */
export function broadcastStart(agentName: string, task: string, index?: number, total?: number): void {
	if (!isNestEnabled) return;

	const key = agentKey(agentName, index);
	getOrCreateBlockId(key);

	const message = buildStatusMessage({
		agentName,
		status: "running",
		task,
		index,
		total,
	});

	sendOrUpdate(key, message);
}

/**
 * Update tool activity for a running subagent (throttled).
 * Updates the persistent status message in-place.
 */
export function broadcastToolActivity(
	agentName: string,
	toolName: string,
	toolCount: number,
	index?: number,
	total?: number,
	extra?: {
		task?: string;
		currentToolArgs?: string;
		durationMs?: number;
		tokens?: number;
		recentOutput?: string[];
	},
): void {
	if (!isNestEnabled) return;

	const key = agentKey(agentName, index);
	if (shouldThrottle(key)) return;

	const message = buildStatusMessage({
		agentName,
		status: "running",
		task: extra?.task ?? "(running)",
		index,
		total,
		toolCount,
		currentTool: toolName,
		currentToolArgs: extra?.currentToolArgs,
		durationMs: extra?.durationMs,
		tokens: extra?.tokens,
		recentOutput: extra?.recentOutput,
	});

	sendOrUpdate(key, message);
}

/**
 * Broadcast that a subagent completed. Final update to the persistent message.
 */
export function broadcastComplete(
	agentName: string,
	exitCode: number,
	durationMs: number,
	error?: string,
	index?: number,
	total?: number,
	extra?: {
		task?: string;
		toolCount?: number;
		tokens?: number;
		recentOutput?: string[];
	},
): void {
	if (!isNestEnabled) return;

	const key = agentKey(agentName, index);
	// Ensure block exists for the final update
	getOrCreateBlockId(key);

	const message = buildStatusMessage({
		agentName,
		status: exitCode === 0 ? "completed" : "failed",
		task: extra?.task ?? "(completed)",
		index,
		total,
		toolCount: extra?.toolCount,
		durationMs,
		tokens: extra?.tokens,
		recentOutput: extra?.recentOutput,
		error,
	});

	sendOrUpdate(key, message).then(() => {
		// Clean up tracking state
		agentBlocks.delete(key);
	});
}

/**
 * Broadcast a chain step starting.
 */
export function broadcastChainStep(stepIndex: number, totalSteps: number, agentName: string, task: string): void {
	if (!isNestEnabled) return;

	// Chain steps share a single persistent message keyed by step index
	const key = `chain-${stepIndex}`;
	getOrCreateBlockId(key);

	const { icon, name } = getDisplay(agentName);
	const taskSummary = truncate(task, TASK_SUMMARY_MAX);

	const message = `🔗 **Chain Step ${stepIndex + 1}/${totalSteps}** — ${icon} ${name}\n> ${taskSummary}`;
	sendOrUpdate(key, message);
}

/**
 * Broadcast parallel execution starting.
 */
export function broadcastParallelStart(tasks: Array<{ agent: string; task: string }>): void {
	if (!isNestEnabled) return;

	const lines = tasks.map((t, i) => {
		const { icon, name } = getDisplay(t.agent);
		return `  ${i + 1}. ${icon} **${name}**: ${truncate(t.task, 80)}`;
	});

	const key = "parallel-header";
	getOrCreateBlockId(key);
	const message = `⚡ Running **${tasks.length} agents** in parallel:\n${lines.join("\n")}`;
	sendOrUpdate(key, message);
}

/**
 * Broadcast overall parallel execution complete.
 */
export function broadcastParallelComplete(succeeded: number, total: number, durationMs: number): void {
	if (!isNestEnabled) return;

	const duration = formatDuration(durationMs);
	const allOk = succeeded === total;
	const icon = allOk ? "✅" : "⚠️";

	// Update the parallel header message
	const key = "parallel-header";
	const message = `${icon} Parallel execution complete: **${succeeded}/${total}** succeeded (${duration})`;
	sendOrUpdate(key, message).then(() => {
		agentBlocks.delete(key);
	});
}
