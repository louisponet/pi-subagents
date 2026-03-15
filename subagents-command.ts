/**
 * /subagents command — live subagent session monitor
 *
 * Opens a TUI overlay showing running/recent subagent sessions,
 * with the ability to drill into session details and abort running processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, decodeKittyPrintable } from "@mariozechner/pi-tui";
import { type AsyncJobState, type AsyncStatus, ASYNC_DIR } from "./types.js";
import { readStatus } from "./utils.js";
import { formatDuration, formatTokens } from "./formatters.js";

// ============================================================================
// Types
// ============================================================================

interface RunInfo {
	runId: string;
	asyncDir: string;
	status: AsyncStatus;
}

interface DetailEntry {
	timestamp: string; // HH:MM:SS or ""
	icon: string;
	text: string;
	isError?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_RUNS = 20;
const POLL_MS = 2000;
const CONTEXT_WINDOW_TOKENS = 200_000;

// ============================================================================
// Formatting helpers
// ============================================================================

function getStatusColor(state: string): "warning" | "success" | "error" | "dim" | "text" {
	if (state === "running") return "warning";
	if (state === "complete" || state === "completed") return "success";
	if (state === "failed") return "error";
	if (state === "queued") return "dim";
	return "text";
}

function getStatusIcon(state: string): string {
	if (state === "running") return "●";
	if (state === "complete" || state === "completed") return "✓";
	if (state === "failed") return "✗";
	if (state === "queued") return "○";
	return "?";
}

function formatTimeFromIso(iso: string): string {
	try {
		const d = new Date(iso);
		if (isNaN(d.getTime())) return "";
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	} catch {
		return "";
	}
}

function formatTimeFromMs(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function formatRunDuration(status: AsyncStatus): string {
	const start = status.startedAt;
	if (!start) return "-";
	const end = status.endedAt ?? Date.now();
	return formatDuration(end - start);
}

function getAgentLabel(status: AsyncStatus): string {
	const agents = status.steps?.map((s) => s.agent) ?? [];
	return agents.length > 0 ? agents.join(" → ") : "unknown";
}

function getStepDisplay(status: AsyncStatus): string {
	const total = status.steps?.length ?? 0;
	if (total === 0) return "-/-";
	if (status.state === "complete" || status.state === "completed") return `${total}/${total}`;
	const current = (status.currentStep ?? 0) + 1;
	return `${Math.min(current, total)}/${total}`;
}

function getTokenDisplay(status: AsyncStatus): string {
	const t = status.totalTokens;
	if (!t || t.total === 0) return "-";
	return formatTokens(t.total);
}

// ============================================================================
// Session file discovery
// ============================================================================

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		return null;
	}
}

function getSessionFilePath(status: AsyncStatus): string | null {
	if (status.sessionFile) return status.sessionFile;
	if (status.sessionDir) return findLatestSessionFile(status.sessionDir);
	return null;
}

// ============================================================================
// Run discovery
// ============================================================================

function loadAllRuns(): RunInfo[] {
	const runs: RunInfo[] = [];
	try {
		if (!fs.existsSync(ASYNC_DIR)) return runs;
		const entries = fs.readdirSync(ASYNC_DIR, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const asyncDir = path.join(ASYNC_DIR, e.name);
			const status = readStatus(asyncDir);
			if (!status) continue;
			runs.push({ runId: status.runId ?? e.name, asyncDir, status });
		}
	} catch {
		// ignore errors scanning directory
	}
	runs.sort((a, b) => (b.status.startedAt ?? 0) - (a.status.startedAt ?? 0));
	return runs;
}

// ============================================================================
// Session JSONL parsing
// ============================================================================

function toolIcon(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "bash" || lower.includes("_bash") || lower.startsWith("bash_")) return "🔨";
	if (lower === "read" || lower.includes("_read") || lower.startsWith("read_")) return "📖";
	if (lower.includes("edit") || lower.includes("write")) return "✏️";
	if (lower.includes("grep") || lower.includes("find") || lower.includes("search")) return "🔍";
	if (lower === "ls" || lower === "list") return "📂";
	if (lower.includes("subagent")) return "🤖";
	if (lower.includes("muninn") || lower.includes("memory")) return "🧠";
	return "🔧";
}

function parseSessionJsonl(sessionFile: string): DetailEntry[] {
	const entries: DetailEntry[] = [];
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				parseSessionEntry(JSON.parse(trimmed), entries);
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// file not ready yet
	}
	return entries;
}

function parseSessionEntry(entry: unknown, out: DetailEntry[]): void {
	if (!entry || typeof entry !== "object") return;
	const e = entry as Record<string, unknown>;
	const type = e.type as string;

	if (type === "compaction") {
		out.push({ timestamp: "", icon: "⚡", text: "Context compacted" });
		return;
	}

	if (type !== "message") return;

	const msg = e.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const role = msg.role as string;
	const ts =
		typeof e.timestamp === "string"
			? formatTimeFromIso(e.timestamp as string)
			: typeof e.timestamp === "number"
				? formatTimeFromMs(e.timestamp as number)
				: "";

	if (role === "assistant") {
		const content = msg.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				// pi session format uses "toolCall"; Anthropic API uses "tool_use"
				if (p.type === "toolCall" || p.type === "tool_use") {
					const toolName = String(p.name ?? "tool");
					const icon = toolIcon(toolName);
					// pi uses "arguments"; Anthropic API uses "input"
					const args = (p.arguments ?? p.input) as Record<string, unknown> | undefined;
					let preview = "";
					if (args) {
						const previewKeys = [
							"command",
							"path",
							"file_path",
							"pattern",
							"query",
							"url",
							"task",
							"agent",
							"context",
							"entity_name",
							"offset",
						];
						for (const key of previewKeys) {
							const val = args[key];
							if (val && typeof val === "string") {
								preview = val.length > 60 ? `${val.slice(0, 57)}...` : val;
								break;
							}
						}
					}
					out.push({ timestamp: ts, icon, text: preview ? `${toolName}: ${preview}` : toolName });
				} else if (p.type === "text") {
					const text = String(p.text ?? "").trim();
					if (text) {
						const firstLine = text.split("\n").find((l) => l.trim()) ?? text;
						const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
						out.push({ timestamp: ts, icon: "💬", text: truncated });
					}
				}
				// type "thinking" → skip
			}
		} else if (typeof content === "string" && content.trim()) {
			const firstLine = content.split("\n").find((l) => l.trim()) ?? content;
			const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
			out.push({ timestamp: ts, icon: "💬", text: truncated });
		}
	} else if (role === "toolResult") {
		// Only show errors from tool results
		if (msg.isError === true) {
			const content = msg.content;
			let errorText = "Tool error";
			if (typeof content === "string") {
				errorText = content.slice(0, 120);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && "text" in part) {
						errorText = String((part as { text: unknown }).text).slice(0, 120);
						break;
					}
				}
			}
			out.push({ timestamp: ts, icon: "❗", text: errorText, isError: true });
		}
	}
}

/**
 * Parse the last assistant message's usage data from a session JSONL file.
 * Returns totalTokens or null if not available.
 */
function parseLatestUsage(sessionFile: string): { totalTokens: number } | null {
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());
		// Scan backwards to find the last assistant message with usage data
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
				if (parsed.type !== "message") continue;
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (!msg) continue;
				if (msg.role !== "assistant") continue;
				const usage = msg.usage as Record<string, unknown> | undefined;
				if (!usage) continue;
				const totalTokens = usage.totalTokens as number | undefined;
				if (typeof totalTokens === "number" && totalTokens > 0) {
					return { totalTokens };
				}
			} catch {
				// skip malformed
			}
		}
	} catch {
		// file not ready
	}
	return null;
}

/**
 * Get the last 2 meaningful activity lines from a session JSONL (for list preview).
 * Reads only the tail of the file for performance.
 */
function getLastActivityEntries(sessionFile: string, count: number): DetailEntry[] {
	try {
		// Read last 8KB to get recent entries without loading full file
		const stat = fs.statSync(sessionFile);
		const fileSize = stat.size;
		const readSize = Math.min(fileSize, 8192);
		const fd = fs.openSync(sessionFile, "r");
		const buf = Buffer.allocUnsafe(readSize);
		fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
		fs.closeSync(fd);
		const tail = buf.toString("utf-8");
		// Split into lines — first line may be partial, skip it
		const rawLines = tail.split("\n");
		const lines = fileSize > readSize ? rawLines.slice(1) : rawLines;

		const entries: DetailEntry[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				parseSessionEntry(JSON.parse(trimmed), entries);
			} catch {
				// skip
			}
		}
		// Return last `count` entries
		return entries.slice(-count);
	} catch {
		return [];
	}
}

// ============================================================================
// SubagentsMonitor TUI Component
// ============================================================================

type View = "list" | "detail";

export class SubagentsMonitor implements Component {
	// View state
	private view: View = "list";

	// List view
	private runs: RunInfo[] = [];
	private selectedIndex = 0;

	// Detail view
	private detailRun: RunInfo | null = null;
	private detailEntries: DetailEntry[] = [];
	private detailScrollOffset = 0;
	private detailAutoScroll = true;

	// Steering input (always visible in detail view)
	private steerFocused = false; // true = steer bar is focused (typing mode)
	private steerInput = ""; // current input buffer

	// Confirm kill overlay (shown on top of current view)
	private confirmingKill = false;

	// Session filter
	private showAll = false;

	// Polling
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	// Render cache
	private cachedLines: string[] | null = null;
	private cachedWidth = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (result: null) => void,
		private asyncJobs: Map<string, AsyncJobState>,
		private sessionId: string | null = null,
	) {
		this.loadRuns();
		this.startPolling();
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	private loadRuns(): void {
		const allRuns = loadAllRuns();
		const filtered =
			!this.showAll && this.sessionId
				? allRuns.filter((r) => r.status.sessionId === this.sessionId)
				: allRuns;
		this.runs = filtered.slice(0, MAX_RUNS);
		if (this.selectedIndex >= this.runs.length && this.runs.length > 0) {
			this.selectedIndex = this.runs.length - 1;
		}
	}

	private refreshDetailRun(): void {
		if (!this.detailRun) return;
		const newStatus = readStatus(this.detailRun.asyncDir);
		if (newStatus) {
			this.detailRun = { ...this.detailRun, status: newStatus };
		}
		const sessionFile = getSessionFilePath(this.detailRun.status);
		if (sessionFile) {
			this.detailEntries = parseSessionJsonl(sessionFile);
		}
	}

	// ── Polling ───────────────────────────────────────────────────────────────

	private startPolling(): void {
		this.pollTimer = setInterval(() => {
			this.loadRuns();
			if (this.view === "detail") {
				this.refreshDetailRun();
			}
			this.invalidate();
			this.tui.requestRender();
		}, POLL_MS);
		this.pollTimer.unref?.();
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// ── Kill ──────────────────────────────────────────────────────────────────

	private tryKill(run: RunInfo): void {
		const pid = run.status.pid;
		if (!pid) return;
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// process already dead or no permission
		}
	}

	private getKillTarget(): RunInfo | null {
		return this.view === "detail" ? this.detailRun : (this.runs[this.selectedIndex] ?? null);
	}

	private canKill(run: RunInfo | null): boolean {
		if (!run) return false;
		const s = run.status.state;
		return s === "running" || s === "queued";
	}

	// ── Steering ──────────────────────────────────────────────────────────────

	private canSteer(run: RunInfo | null): boolean {
		if (!run) return false;
		const s = run.status.state;
		return s === "running" || s === "queued";
	}

	private sendSteer(text: string): void {
		if (!this.detailRun) return;
		// Find the stdinWriter from asyncJobs
		const job = this.asyncJobs.get(this.detailRun.runId);
		if (!job?.stdinWriter) return;
		try {
			job.stdinWriter(JSON.stringify({ type: "steer", message: text }) + "\n");
		} catch {
			// writer may be closed
		}
	}

	// ── Input handling ────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.confirmingKill) {
			this.handleConfirmInput(data);
		} else if (this.view === "list") {
			this.handleListInput(data);
		} else {
			this.handleDetailInput(data);
		}
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedIndex < this.runs.length - 1) {
				this.selectedIndex++;
				this.invalidate();
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.enter)) {
			const run = this.runs[this.selectedIndex];
			if (run) this.openDetail(run);
		} else if (matchesKey(data, Key.alt("k"))) {
			if (this.canKill(this.runs[this.selectedIndex] ?? null)) {
				this.confirmingKill = true;
				this.invalidate();
				this.tui.requestRender();
			}
		} else if (data === "a" || data === "A") {
			this.showAll = !this.showAll;
			this.selectedIndex = 0;
			this.loadRuns();
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.escape)) {
			this.stopPolling();
			this.done(null);
		}
	}

	private openDetail(run: RunInfo): void {
		this.detailRun = run;
		this.detailScrollOffset = 0;
		this.detailAutoScroll = true;
		this.steerFocused = false;
		this.steerInput = "";
		const sessionFile = getSessionFilePath(run.status);
		this.detailEntries = sessionFile ? parseSessionJsonl(sessionFile) : [];
		this.view = "detail";
		this.invalidate();
		this.tui.requestRender();
	}

	private handleDetailInput(data: string): void {
		// When steer bar is focused, route all input there
		if (this.steerFocused) {
			this.handleSteerInput(data);
			return;
		}

		// Timeline scroll mode
		if (matchesKey(data, Key.up)) {
			if (this.detailScrollOffset > 0) {
				this.detailScrollOffset--;
				this.detailAutoScroll = false;
				this.invalidate();
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.down)) {
			// Will be clamped in render; check auto-follow resume after clamping
			this.detailScrollOffset++;
			this.detailAutoScroll = false;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageUp)) {
			this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 15);
			this.detailAutoScroll = false;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageDown)) {
			this.detailScrollOffset += 15;
			this.detailAutoScroll = false;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.alt("k"))) {
			if (this.canKill(this.detailRun)) {
				this.confirmingKill = true;
				this.invalidate();
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.escape)) {
			this.view = "list";
			this.detailRun = null;
			this.detailEntries = [];
			this.steerFocused = false;
			this.steerInput = "";
			this.invalidate();
			this.tui.requestRender();
		} else if (this.canSteer(this.detailRun)) {
			// Any printable character goes to steer bar and focuses it
			const ch = decodeKittyPrintable(data);
			const isPrintable = ch !== undefined || (data.length === 1 && data.charCodeAt(0) >= 32);
			if (isPrintable) {
				const char = ch ?? data;
				this.steerInput += char;
				this.steerFocused = true;
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}

	private handleSteerInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			// Send steer command
			const text = this.steerInput.trim();
			if (text) {
				this.sendSteer(text);
			}
			this.steerInput = "";
			this.steerFocused = false;
			this.detailAutoScroll = true; // re-enable auto-follow after steering
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.escape)) {
			// Cancel steer and return to scroll mode
			this.steerFocused = false;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.backspace)) {
			if (this.steerInput.length > 0) {
				this.steerInput = this.steerInput.slice(0, -1);
				this.invalidate();
				this.tui.requestRender();
			}
		} else {
			// Append printable chars
			const ch = decodeKittyPrintable(data);
			const isPrintable = ch !== undefined || (data.length === 1 && data.charCodeAt(0) >= 32);
			if (isPrintable) {
				this.steerInput += ch ?? data;
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}

	private handleConfirmInput(data: string): void {
		if (data === "y" || data === "Y") {
			const target = this.getKillTarget();
			if (target) this.tryKill(target);
		}
		// Any input (y/n/escape/other) closes the confirm prompt
		this.confirmingKill = false;
		this.invalidate();
		this.tui.requestRender();
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	invalidate(): void {
		this.cachedLines = null;
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Inner content width: subtract 2 chars on each side for "│ " and " │"
		const innerWidth = Math.max(4, width - 4);
		const t = this.theme;

		// Generate inner content lines at reduced width
		const contentLines =
			this.view === "list" ? this.renderList(innerWidth) : this.renderDetail(innerWidth);

		// Append kill confirmation inside the box
		if (this.confirmingKill) {
			const target = this.getKillTarget();
			const targetName = target
				? `${target.runId.slice(0, 8)} (${getAgentLabel(target.status)})`
				: "this run";
			contentLines.push("");
			contentLines.push(
				truncateToWidth(
					`${t.fg("warning", `Kill ${targetName}?`)} ` +
						`${t.bold(t.fg("error", "[y]"))}${t.fg("dim", "es")} / ` +
						`${t.bold(t.fg("success", "[n]"))}${t.fg("dim", "o")}`,
					innerWidth,
				),
			);
		}

		// Wrap content in a box border using box-drawing characters
		const bdr = (s: string) => t.fg("border", s);
		const topBorder = bdr(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
		const bottomBorder = bdr(`╰${"─".repeat(Math.max(0, width - 2))}╯`);

		const result: string[] = [topBorder];
		for (const line of contentLines) {
			const vw = visibleWidth(line);
			const padding = Math.max(0, innerWidth - vw);
			const padded = line + " ".repeat(padding);
			result.push(bdr("│") + " " + padded + " " + bdr("│"));
		}
		result.push(bottomBorder);

		this.cachedLines = result;
		this.cachedWidth = width;
		return result;
	}

	private headerLine(width: number, title: string, hint: string): string {
		const t = this.theme;
		const left = ` ${title}`;
		const right = `${hint} `;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(t.bold(left) + " ".repeat(gap) + t.fg("dim", right), width);
	}

	private sepLine(width: number, scrollInfo?: string): string {
		const t = this.theme;
		const info = scrollInfo ?? "";
		const infoWidth = visibleWidth(info);
		const dashCount = Math.max(0, width - infoWidth);
		return t.fg("dim", "─".repeat(dashCount) + info);
	}

	// ── List view ─────────────────────────────────────────────────────────────

	private renderList(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];

		const filterHint = this.sessionId
			? this.showAll
				? "[a] this session  [alt+k]ill  [Enter] details  [Esc] close"
				: "[a]ll sessions  [alt+k]ill  [Enter] details  [Esc] close"
			: "[alt+k]ill  [Enter] details  [Esc] close";
		lines.push(this.headerLine(width, "Subagent Sessions", filterHint));
		lines.push(this.sepLine(width));

		if (this.runs.length === 0) {
			if (!this.showAll && this.sessionId) {
				lines.push(truncateToWidth(t.fg("dim", "  No subagent runs in this session. Press [a] to show all sessions."), width));
			} else {
				lines.push(truncateToWidth(t.fg("dim", "  No recent subagent runs found."), width));
			}
			return lines;
		}

		// Column widths
		const idW = 10;
		const statusW = 12;
		const stepW = 7;
		const durW = 10;
		const tokW = 8;
		const agentW = Math.max(18, width - 2 - idW - statusW - stepW - durW - tokW);

		const colHdr =
			"  " +
			"ID".padEnd(idW) +
			"Agent(s)".padEnd(agentW) +
			"Status".padEnd(statusW) +
			"Step".padEnd(stepW) +
			"Duration".padEnd(durW) +
			"Tokens";
		lines.push(truncateToWidth(t.fg("dim", colHdr), width));

		const runLineIndices: number[] = []; // line index where each run starts
		for (let i = 0; i < this.runs.length; i++) {
			const run = this.runs[i]!;
			const isSelected = i === this.selectedIndex;
			const sel = isSelected ? "▸ " : "  ";
			const state = run.status.state;
			const id = run.runId.slice(0, 8);
			const agents = getAgentLabel(run.status);
			const agentTrunc = agents.length > agentW - 1 ? `${agents.slice(0, agentW - 4)}...` : agents;
			const step = getStepDisplay(run.status);
			const dur = formatRunDuration(run.status);
			const tok = getTokenDisplay(run.status);
			const statusStr = `${getStatusIcon(state)} ${state}`;

			const row =
				sel +
				id.padEnd(idW) +
				agentTrunc.padEnd(agentW) +
				statusStr.padEnd(statusW) +
				step.padEnd(stepW) +
				dur.padEnd(durW) +
				tok;

			const color = getStatusColor(state);
			const line = isSelected
				? t.bold(t.fg(color, truncateToWidth(row, width)))
				: state === "running"
					? truncateToWidth(t.fg("warning", row), width)
					: truncateToWidth(row, width);

			runLineIndices.push(lines.length);
			lines.push(line);

			// Show last 2 activity lines below each row (dimmed)
			const sessionFile = getSessionFilePath(run.status);
			if (sessionFile) {
				const activityEntries = getLastActivityEntries(sessionFile, 2);
				const indent = "    "; // 4 spaces to align with row content
				const maxTextWidth = width - indent.length - 4; // room for icon + space
				for (const entry of activityEntries) {
					const icon = entry.icon;
					const text = entry.text.length > maxTextWidth ? `${entry.text.slice(0, maxTextWidth - 3)}...` : entry.text;
					const actLine = `${indent}${icon} ${entry.isError ? t.fg("error", text) : t.fg("dim", text)}`;
					lines.push(truncateToWidth(actLine, width));
				}
			}
		}

		// Viewport height constraint — respect overlay maxHeight: "80%"
		const overlayMaxHeight = Math.floor((process.stdout.rows ?? 40) * 0.8);
		const boxBorderLines = 2; // top + bottom border from render()
		const maxVisibleLines = Math.max(10, overlayMaxHeight - boxBorderLines);

		if (lines.length > maxVisibleLines) {
			// First 3 lines are fixed header (title + sep + column header)
			const headerCount = 3;
			const header = lines.slice(0, Math.min(headerCount, lines.length));
			const body = lines.slice(headerCount);
			const bodyViewHeight = maxVisibleLines - header.length;

			if (body.length > bodyViewHeight) {
				// Keep selected run visible — find its position in body
				const selectedBodyLine = Math.max(0, (runLineIndices[this.selectedIndex] ?? 0) - headerCount);
				let scrollOffset = Math.max(0, selectedBodyLine - Math.floor(bodyViewHeight / 3));
				scrollOffset = Math.min(scrollOffset, Math.max(0, body.length - bodyViewHeight));
				const visible = body.slice(scrollOffset, scrollOffset + bodyViewHeight);
				const scrollInfo = ` [${scrollOffset + 1}-${Math.min(scrollOffset + bodyViewHeight, body.length)}/${body.length}]`;
				header[1] = this.sepLine(width, scrollInfo);
				return [...header, ...visible];
			}
		}

		return lines;
	}

	// ── Detail view ───────────────────────────────────────────────────────────

	private renderDetail(width: number): string[] {
		const run = this.detailRun;
		if (!run) return [];

		const t = this.theme;
		const agentLabel = getAgentLabel(run.status);
		const state = run.status.state;

		// Context window usage
		let tokenUsageStr = "";
		const sessionFile = getSessionFilePath(run.status);
		if (sessionFile) {
			const usage = parseLatestUsage(sessionFile);
			if (usage) {
				const total = usage.totalTokens;
				const pct = Math.round((total / CONTEXT_WINDOW_TOKENS) * 100);
				const totalK = (total / 1000).toFixed(1);
				const ctxK = (CONTEXT_WINDOW_TOKENS / 1000).toFixed(0);
				tokenUsageStr = `  Context: ${totalK}k / ${ctxK}k tokens (${pct}%)`;
			}
		}

		// Fixed header lines
		const titleLine = this.headerLine(
			width,
			`Run ${run.runId.slice(0, 8)} — ${agentLabel} (${state}, step ${getStepDisplay(run.status)})`,
			"[alt+k]ill  [Esc] back",
		);
		const startStr = run.status.startedAt ? formatTimeFromMs(run.status.startedAt) : "-";
		const infoLine = truncateToWidth(
			t.fg("dim", ` Started: ${startStr}  Duration: ${formatRunDuration(run.status)}  Tokens: ${getTokenDisplay(run.status)}${tokenUsageStr}`),
			width,
		);

		// Build scrollable content
		const content: string[] = [];
		const steps = run.status.steps ?? [];

		// Step status summaries from status.json
		for (let si = 0; si < steps.length; si++) {
			const st = steps[si]!;
			const dashLen = Math.max(2, width - 16 - st.agent.length);
			content.push(truncateToWidth(t.fg("dim", `── step ${si + 1}: ${st.agent} ${"─".repeat(dashLen)}`), width));
			const stState = st.status;
			if (stState !== "pending" && stState !== "running") {
				const parts: string[] = [];
				if (st.durationMs) parts.push(formatDuration(st.durationMs));
				if (st.tokens?.total) parts.push(`${formatTokens(st.tokens.total)} tokens`);
				if (st.error) parts.push(`error: ${st.error.slice(0, 50)}`);
				if (parts.length > 0) {
					const color = getStatusColor(stState);
					content.push(
						truncateToWidth(
							t.fg(color, `   ${getStatusIcon(stState)} ${stState} (${parts.join(", ")})`),
							width,
						),
					);
				}
			}
		}

		// Session timeline entries
		if (this.detailEntries.length > 0) {
			if (steps.length > 0) {
				const tl = "── timeline ";
				content.push(truncateToWidth(t.fg("dim", tl + "─".repeat(Math.max(2, width - tl.length))), width));
			}
			for (const entry of this.detailEntries) {
				const ts = entry.timestamp ? t.fg("dim", `${entry.timestamp}  `) : "          ";
				const textPart = entry.isError ? t.fg("error", entry.text) : entry.text;
				content.push(truncateToWidth(`${ts}${entry.icon} ${textPart}`, width));
			}
		} else if (steps.length === 0) {
			content.push(truncateToWidth(t.fg("dim", "  (waiting for session data...)"), width));
		}

		if (content.length === 0) {
			content.push(truncateToWidth(t.fg("dim", "  (no timeline data available)"), width));
		}

		// Viewport management
		// STEER_RESERVED: separator + input line + hint line = 3 lines
		const HEADER_LINES = 3; // title + info + sep
		const STEER_RESERVED = 3; // steer sep + steer input + steer hint
		const overlayHeight = Math.floor((process.stdout.rows ?? 40) * 0.8);
		const viewHeight = Math.max(8, overlayHeight - HEADER_LINES - STEER_RESERVED - 2); // -2 for box borders
		const maxScroll = Math.max(0, content.length - viewHeight);

		if (this.detailAutoScroll) {
			this.detailScrollOffset = maxScroll;
		} else {
			this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScroll));
			// Resume auto-follow when scrolled back to the bottom
			if (this.detailScrollOffset >= maxScroll) {
				this.detailAutoScroll = true;
			}
		}

		// Build separator with optional scroll info embedded
		const scrollInfo =
			content.length > viewHeight
				? ` [${this.detailScrollOffset + 1}-${Math.min(this.detailScrollOffset + viewHeight, content.length)}/${content.length}]`
				: undefined;

		const isRunning = this.canSteer(run);
		const steerBarFocused = this.steerFocused && isRunning;

		// Steer bar lines (always shown at bottom)
		const steerSep = this.sepLine(width);
		let steerLine: string;
		let steerHint: string;
		if (!isRunning) {
			// Agent not running — show disabled bar
			steerLine = truncateToWidth(t.fg("dim", "  (agent not running — steering unavailable)"), width);
			steerHint = truncateToWidth(t.fg("dim", "[↑↓] scroll  [Esc] back"), width);
		} else if (steerBarFocused) {
			// Focused: show active input with cursor
			const inputDisplay = this.steerInput + "█";
			steerLine = truncateToWidth(`  ✉ ${inputDisplay}`, width);
			steerHint = truncateToWidth(t.fg("dim", "[Enter] send  [Esc] cancel  [Backspace] delete"), width);
		} else {
			// Unfocused but available: show placeholder
			const placeholder = this.steerInput.length > 0 ? this.steerInput : t.fg("dim", "Type to steer...");
			steerLine = truncateToWidth(`  ✉ ${placeholder}`, width);
			steerHint = truncateToWidth(t.fg("dim", "[↑↓] scroll  [alt+k]ill  [Esc] back  type to steer"), width);
		}

		const lines: string[] = [titleLine, infoLine, this.sepLine(width, scrollInfo)];
		lines.push(...content.slice(this.detailScrollOffset, this.detailScrollOffset + viewHeight));
		// Always-on steer bar at bottom
		lines.push(steerSep);
		lines.push(steerLine);
		lines.push(steerHint);
		return lines;
	}
}

// ============================================================================
// Command registration
// ============================================================================

export function registerSubagentsCommand(
	pi: ExtensionAPI,
	asyncJobs: Map<string, AsyncJobState>,
	getSessionId: () => string | null,
): void {
	pi.registerCommand("subagents", {
		description: "Show live subagent session monitor",
		handler: async (_args, ctx) => {
			const sessionId = getSessionId();
			await ctx.ui.custom<null>(
				(tui, theme, _kb, done) => new SubagentsMonitor(tui, theme, done, asyncJobs, sessionId),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						anchor: "center",
						maxHeight: "80%",
					},
				},
			);
		},
	});
}
