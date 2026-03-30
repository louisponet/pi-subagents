/**
 * Error message helpers for the subagent extension.
 */

import type { AgentConfig } from "./agents.js";

/**
 * Format a consistent "Unknown agent" error with the list of available agents.
 */
export function unknownAgentError(agentName: string, agents: AgentConfig[], suffix?: string): string {
	const names = [...new Set(agents.map((a) => a.name))];
	const available = names.join(", ");
	return `Unknown agent: "${agentName}".${suffix ? ` ${suffix}` : ""} Available agents: ${available || "none"} (use action: "list" for full details)`;
}
