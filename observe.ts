/**
 * Observe tool — inspect running/completed subagent sessions
 *
 * Two modes:
 * - summary: compact step list (~50 lines) for quick "what's it doing?" checks
 * - deep: full conversation view for evaluating if agent is on/off track
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type AsyncStatus, ASYNC_DIR } from "./types.js";
import { readStatus } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

interface SessionEntry {
	timestamp: string;
	role: "assistant" | "tool" | "user" | "system";
	thinking?: string;
	text?: string;
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	toolResults?: Array<{ name: string; content: string }>;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
	stopReason?: string;
}

interface StepInfo {
	index: number;
	icon: string;
	label: string;
	timestamp: string;
}

// ============================================================================
// Icon mapping
// ============================================================================

function toolIcon(name: string): string {
	if (name === "read" || name === "Read") return "📖";
	if (name === "bash" || name === "Bash") return "⚡";
	if (name === "edit" || name === "Edit") return "✏️";
	if (name === "write" || name === "Write") return "📝";
	if (name === "subagent") return "🤖";
	if (name.startsWith("muninn")) return "🧠";
	if (name === "review_loop") return "🔄";
	if (name === "zellij_screen" || name === "zellij_type" || name === "zellij_keys" || name === "zellij_panes") return "🖥️";
	if (name === "overseer_keys" || name === "overseer_screenshot") return "👀";
	return "🔧";
}

function toolLabel(name: string, args: Record<string, unknown>): string {
	if (name === "read" || name === "Read") {
		const p = args.path as string | undefined;
		return p ? `Read ${path.basename(p)}` : "Read";
	}
	if (name === "bash" || name === "Bash") {
		const cmd = args.command as string | undefined;
		if (!cmd) return "Bash";
		const first = cmd.split("\n")[0].slice(0, 60);
		return `Bash: ${first}${cmd.length > 60 ? "…" : ""}`;
	}
	if (name === "edit" || name === "Edit") {
		const p = args.path as string | undefined;
		return p ? `Edit ${path.basename(p)}` : "Edit";
	}
	if (name === "write" || name === "Write") {
		const p = args.path as string | undefined;
		return p ? `Write ${path.basename(p)}` : "Write";
	}
	if (name === "subagent") {
		const agent = args.agent as string | undefined;
		return agent ? `Subagent: ${agent}` : "Subagent";
	}
	if (name.startsWith("muninn_")) {
		return name.replace("muninn_", "Memory: ");
	}
	return name;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

function formatTime(ts: string): string {
	try {
		const d = new Date(ts);
		return d.toISOString().slice(11, 16); // HH:MM
	} catch {
		return "??:??";
	}
}

function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m${rem > 0 ? `${rem}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

// ============================================================================
// Session JSONL parsing
// ============================================================================

function findSessionJsonl(status: AsyncStatus): string | null {
	const sessionDir = status.sessionDir;
	if (!sessionDir) return null;

	// sessionDir contains subdirs with .jsonl files
	try {
		const entries = fs.readdirSync(sessionDir);
		for (const entry of entries) {
			const full = path.join(sessionDir, entry);
			if (entry.endsWith(".jsonl") && fs.statSync(full).isFile()) {
				return full;
			}
		}
		// Check subdirs
		for (const entry of entries) {
			const full = path.join(sessionDir, entry);
			if (fs.statSync(full).isDirectory()) {
				const subEntries = fs.readdirSync(full);
				for (const sub of subEntries) {
					if (sub.endsWith(".jsonl")) {
						return path.join(full, sub);
					}
				}
			}
		}
	} catch {}
	return null;
}

function parseSessionJsonl(filePath: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return entries;
	}

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj.type !== "message" || !obj.message) continue;

			const msg = obj.message;
			const entry: SessionEntry = {
				timestamp: obj.timestamp || "",
				role: msg.role || "unknown",
				usage: msg.usage,
				stopReason: msg.stopReason,
			};

			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "thinking" && block.thinking) {
						entry.thinking = block.thinking;
					} else if (block.type === "text" && block.text) {
						entry.text = (entry.text ? entry.text + "\n" : "") + block.text;
					} else if (block.type === "toolCall") {
						if (!entry.toolCalls) entry.toolCalls = [];
						entry.toolCalls.push({ name: block.name, args: block.arguments || {} });
					} else if (block.type === "toolResult") {
						if (!entry.toolResults) entry.toolResults = [];
						const content = typeof block.content === "string"
							? block.content
							: Array.isArray(block.content)
								? block.content.map((c: { text?: string }) => c.text || "").join("\n")
								: JSON.stringify(block.content);
						entry.toolResults.push({ name: block.name || "", content });
					}
				}
			} else if (typeof msg.content === "string") {
				entry.text = msg.content;
			}

			// Tool result messages (role: "tool")
			if (msg.role === "tool" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "toolResult") {
						if (!entry.toolResults) entry.toolResults = [];
						const content = typeof block.content === "string"
							? block.content
							: Array.isArray(block.content)
								? block.content.map((c: { text?: string }) => c.text || "").join("\n")
								: JSON.stringify(block.content);
						entry.toolResults.push({ name: block.name || "", content });
					}
				}
			}

			entries.push(entry);
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

// ============================================================================
// Find run by ID prefix
// ============================================================================

function findRun(idPrefix: string): { runId: string; asyncDir: string; status: AsyncStatus } | null {
	try {
		const dirs = fs.readdirSync(ASYNC_DIR);
		const matches = dirs.filter((d) => d.startsWith(idPrefix));

		if (matches.length === 0) return null;
		if (matches.length > 1) {
			// Try exact match first
			const exact = matches.find((d) => d === idPrefix);
			if (!exact) return null; // ambiguous
		}

		const runId = matches[0];
		const asyncDir = path.join(ASYNC_DIR, runId);
		const status = readStatus(asyncDir);
		if (!status) return null;

		return { runId, asyncDir, status };
	} catch {
		return null;
	}
}

// ============================================================================
// Summary mode
// ============================================================================

function renderSummary(runId: string, status: AsyncStatus, entries: SessionEntry[]): string {
	const agent = status.steps?.[0]?.agent || "unknown";
	const shortId = runId.slice(0, 8);
	const state = status.state || "unknown";
	const elapsed = status.startedAt
		? formatDurationMs(Date.now() - status.startedAt)
		: "?";

	// Extract task from first user/assistant message or status
	let task = "(no task found)";
	// Check the session file referenced in status
	if (status.sessionId) {
		try {
			const sessionLines = fs.readFileSync(status.sessionId, "utf-8").split("\n");
			for (const line of sessionLines) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line);
					if (obj.type === "message" && obj.message?.role === "user") {
						const content = obj.message.content;
						if (typeof content === "string") {
							task = truncate(content, 100);
							break;
						} else if (Array.isArray(content)) {
							for (const block of content) {
								if (block.type === "text" && block.text) {
									task = truncate(block.text, 100);
									break;
								}
							}
							if (task !== "(no task found)") break;
						}
					}
				} catch {}
			}
		} catch {}
	}

	// Collect steps from entries
	const steps: StepInfo[] = [];
	let stepIdx = 0;
	for (const entry of entries) {
		if (entry.role === "assistant" && entry.toolCalls) {
			for (const tc of entry.toolCalls) {
				stepIdx++;
				steps.push({
					index: stepIdx,
					icon: toolIcon(tc.name),
					label: toolLabel(tc.name, tc.args),
					timestamp: formatTime(entry.timestamp),
				});
			}
		}
	}

	// Latest usage
	let latestUsage: SessionEntry["usage"] | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].usage) {
			latestUsage = entries[i].usage;
			break;
		}
	}

	const tokenStr = latestUsage
		? `${(latestUsage.totalTokens / 1000).toFixed(1)}k / 200k (${Math.round((latestUsage.totalTokens / 200_000) * 100)}%)`
		: "n/a";
	const costStr = latestUsage
		? `$${latestUsage.cost.total.toFixed(2)}`
		: "n/a";

	// Current activity
	const lastEntry = entries[entries.length - 1];
	let currentActivity = "idle";
	if (state === "running") {
		if (lastEntry?.stopReason === "toolUse") {
			const lastTc = lastEntry.toolCalls?.[lastEntry.toolCalls.length - 1];
			currentActivity = lastTc
				? `executing ${lastTc.name}...`
				: "executing tool...";
		} else {
			currentActivity = "thinking (between tool calls)";
		}
	} else if (state === "complete") {
		currentActivity = "finished";
	} else if (state === "failed") {
		currentActivity = "failed";
	}

	// Build output
	const lines: string[] = [];
	lines.push(`═══ ${agent} (${shortId}) ═══`);
	lines.push(`Status: ${state} | ${elapsed} elapsed`);
	lines.push(`Task: ${task}`);
	lines.push("");

	// Show last ~20 steps to keep under 50 lines
	const maxSteps = 20;
	const showSteps = steps.length > maxSteps ? steps.slice(-maxSteps) : steps;
	const skipped = steps.length - showSteps.length;

	lines.push(`Steps (${steps.length} total):`);
	if (skipped > 0) {
		lines.push(`  ... ${skipped} earlier steps ...`);
	}
	for (const step of showSteps) {
		lines.push(`  ${String(step.index).padStart(3)}. ${step.icon} ${truncate(step.label, 70)} [${step.timestamp}]`);
	}

	lines.push("");
	lines.push(`Currently: ${currentActivity}`);
	lines.push(`Tokens: ${tokenStr}`);
	lines.push(`Cost: ${costStr}`);

	return lines.join("\n");
}

// ============================================================================
// Deep mode
// ============================================================================

function renderDeep(runId: string, status: AsyncStatus, entries: SessionEntry[], limit: number): string {
	const agent = status.steps?.[0]?.agent || "unknown";
	const shortId = runId.slice(0, 8);
	const state = status.state || "unknown";
	const elapsed = status.startedAt
		? formatDurationMs(Date.now() - status.startedAt)
		: "?";

	let latestUsage: SessionEntry["usage"] | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].usage) {
			latestUsage = entries[i].usage;
			break;
		}
	}

	const tokenStr = latestUsage
		? `${(latestUsage.totalTokens / 1000).toFixed(1)}k tokens (${Math.round((latestUsage.totalTokens / 200_000) * 100)}%)`
		: "";
	const costStr = latestUsage ? `$${latestUsage.cost.total.toFixed(2)}` : "";
	const infoLine = [state, elapsed, tokenStr, costStr].filter(Boolean).join(" | ");

	// Group entries into exchanges (assistant + tool results)
	interface Exchange {
		index: number;
		timestamp: string;
		thinking?: string;
		text?: string;
		toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
		toolResults?: Array<{ name: string; content: string }>;
	}

	const exchanges: Exchange[] = [];
	let exchangeIdx = 0;
	let currentExchange: Exchange | null = null;

	for (const entry of entries) {
		if (entry.role === "assistant") {
			exchangeIdx++;
			currentExchange = {
				index: exchangeIdx,
				timestamp: entry.timestamp,
				thinking: entry.thinking,
				text: entry.text,
				toolCalls: entry.toolCalls,
			};
			exchanges.push(currentExchange);
		} else if (entry.role === "tool" && currentExchange) {
			if (entry.toolResults) {
				if (!currentExchange.toolResults) currentExchange.toolResults = [];
				currentExchange.toolResults.push(...entry.toolResults);
			}
		}
	}

	// Limit to last N exchanges
	const total = exchanges.length;
	const shown = exchanges.slice(-limit);

	const lines: string[] = [];
	lines.push(`═══ ${agent} (${shortId}) — DEEP VIEW (last ${shown.length} of ${total} exchanges) ═══`);
	lines.push(`${infoLine}`);
	lines.push("");

	for (const ex of shown) {
		lines.push(`--- Exchange ${ex.index}/${total} [${formatTime(ex.timestamp)}] ---`);

		if (ex.thinking) {
			lines.push(`[Thinking]: ${truncate(ex.thinking, 200)}`);
		}
		if (ex.text) {
			lines.push(`[Assistant]: ${truncate(ex.text, 300)}`);
		}
		if (ex.toolCalls) {
			for (const tc of ex.toolCalls) {
				const argsStr = Object.entries(tc.args)
					.map(([k, v]) => {
						const vs = typeof v === "string" ? v : JSON.stringify(v);
						return `${k}=${truncate(vs, 60)}`;
					})
					.join(", ");
				lines.push(`[Tool Call]: ${tc.name}(${truncate(argsStr, 100)})`);
			}
		}
		if (ex.toolResults) {
			for (const tr of ex.toolResults) {
				lines.push(`[Tool Result]: (${tr.content.length} chars) ${truncate(tr.content, 500)}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Tool registration
// ============================================================================

const ObserveParams = {
	type: "object" as const,
	properties: {
		id: { type: "string" as const, description: "Run ID or prefix" },
		mode: {
			type: "string" as const,
			enum: ["summary", "deep"],
			description: "summary = compact step list, deep = full conversation view (default: summary)",
		},
		limit: {
			type: "number" as const,
			description: "For deep mode: last N exchanges to show (default: 10)",
		},
	},
	required: ["id"] as const,
};

export function registerObserveTool(pi: { registerTool: (tool: ToolDefinition<typeof ObserveParams, unknown>) => void }): void {
	const observeTool: ToolDefinition<typeof ObserveParams, unknown> = {
		name: "observe",
		label: "Observe Subagent",
		description:
			"Observe a running or completed subagent. Returns activity summary or deep conversation view for evaluating if an agent is on/off track.",
		parameters: ObserveParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const idPrefix = params.id;
			const mode = params.mode || "summary";
			const limit = params.limit || 10;

			const run = findRun(idPrefix);
			if (!run) {
				// Check for ambiguous match
				try {
					const dirs = fs.readdirSync(ASYNC_DIR);
					const matches = dirs.filter((d) => d.startsWith(idPrefix));
					if (matches.length > 1) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} runs:\n${matches.map((m) => `  ${m}`).join("\n")}\nProvide a longer prefix.`,
								},
							],
							isError: true,
						};
					}
				} catch {}
				return {
					content: [{ type: "text" as const, text: `No run found matching "${idPrefix}"` }],
					isError: true,
				};
			}

			const jsonlPath = findSessionJsonl(run.status);
			if (!jsonlPath) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Found run ${run.runId} but no session JSONL available.\nStatus: ${run.status.state}\nDir: ${run.asyncDir}`,
						},
					],
				};
			}

			const entries = parseSessionJsonl(jsonlPath);

			if (mode === "deep") {
				return {
					content: [{ type: "text" as const, text: renderDeep(run.runId, run.status, entries, limit) }],
				};
			}

			return {
				content: [{ type: "text" as const, text: renderSummary(run.runId, run.status, entries) }],
			};
		},
	};

	pi.registerTool(observeTool);
}
