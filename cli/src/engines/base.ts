import { spawn, spawnSync } from "node:child_process";
import type { AIEngine, AIResult, EngineOptions, ProgressCallback, StepInfo } from "./types.ts";

// Check if running in Bun
const isBun = typeof Bun !== "undefined";
const isWindows = process.platform === "win32";

/**
 * Check if a command is available in PATH
 */
export async function commandExists(command: string): Promise<boolean> {
	try {
		const checkCommand = isWindows ? "where" : "which";
		if (isBun) {
			const proc = Bun.spawn([checkCommand, command], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		}
		// Node.js fallback - where/which don't need shell
		const result = spawnSync(checkCommand, [command], { stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Execute a command and return stdout
 * @param stdinContent - Optional content to pass via stdin (useful for multi-line prompts on Windows)
 */
export async function execCommand(
	command: string,
	args: string[],
	workDir: string,
	env?: Record<string, string>,
	stdinContent?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (isBun) {
		// On Windows, run through cmd.exe to handle .cmd wrappers (npm global packages)
		const spawnArgs = isWindows ? ["cmd.exe", "/c", command, ...args] : [command, ...args];
		const proc = Bun.spawn(spawnArgs, {
			cwd: workDir,
			stdin: stdinContent ? "pipe" : "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		// Write stdin content if provided
		if (stdinContent && proc.stdin) {
			proc.stdin.write(stdinContent);
			proc.stdin.end();
		}

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { stdout, stderr, exitCode };
	}

	// Node.js fallback - use shell on Windows to execute .cmd wrappers
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: workDir,
			env: { ...process.env, ...env },
			stdio: [stdinContent ? "pipe" : "ignore", "pipe", "pipe"],
			shell: isWindows, // Required on Windows for npm global commands (.cmd wrappers)
		});

		// Write stdin content if provided
		if (stdinContent && proc.stdin) {
			proc.stdin.write(stdinContent);
			proc.stdin.end();
		}

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
		});

		proc.on("error", (err) => {
			// Maintain backward compatibility - don't reject, include error in stderr
			stderr += `\nSpawn error: ${err.message}`;
			resolve({ stdout, stderr, exitCode: 1 });
		});
	});
}

/**
 * Parse token counts from stream-json output (Claude/Qwen format)
 */
export function parseStreamJsonResult(output: string): {
	response: string;
	inputTokens: number;
	outputTokens: number;
} {
	const lines = output.split("\n").filter(Boolean);
	let response = "";
	let inputTokens = 0;
	let outputTokens = 0;

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "result") {
				response = parsed.result || "Task completed";
				inputTokens = parsed.usage?.input_tokens || 0;
				outputTokens = parsed.usage?.output_tokens || 0;
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return { response: response || "Task completed", inputTokens, outputTokens };
}

/**
 * Check for errors in stream-json output
 */
export function checkForErrors(output: string): string | null {
	const lines = output.split("\n").filter(Boolean);

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "error") {
				return parsed.error?.message || parsed.message || "Unknown error";
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return null;
}

/**
 * Format a command failure with useful output context.
 */
export function formatCommandError(exitCode: number, output: string): string {
	const trimmed = output.trim();
	if (!trimmed) {
		return `Command failed with exit code ${exitCode}`;
	}

	const lines = trimmed.split("\n").filter(Boolean);
	const snippet = lines.slice(-12).join("\n");
	return `Command failed with exit code ${exitCode}. Output:\n${snippet}`;
}

/**
 * Read a stream line by line, calling onLine for each non-empty line
 */
async function readStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line);
			}
		}
		if (buffer.trim()) onLine(buffer);
	} finally {
		reader.releaseLock();
	}
}

/**
 * Execute a command with streaming output, calling onLine for each line
 * @param stdinContent - Optional content to pass via stdin (useful for multi-line prompts on Windows)
 */
export async function execCommandStreaming(
	command: string,
	args: string[],
	workDir: string,
	onLine: (line: string) => void,
	env?: Record<string, string>,
	stdinContent?: string,
): Promise<{ exitCode: number }> {
	if (isBun) {
		// On Windows, run through cmd.exe to handle .cmd wrappers (npm global packages)
		const spawnArgs = isWindows ? ["cmd.exe", "/c", command, ...args] : [command, ...args];
		const proc = Bun.spawn(spawnArgs, {
			cwd: workDir,
			stdin: stdinContent ? "pipe" : "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		// Write stdin content if provided
		if (stdinContent && proc.stdin) {
			proc.stdin.write(stdinContent);
			proc.stdin.end();
		}

		// Process both stdout and stderr in parallel
		await Promise.all([readStream(proc.stdout, onLine), readStream(proc.stderr, onLine)]);

		const exitCode = await proc.exited;
		return { exitCode };
	}

	// Node.js fallback - use shell on Windows to execute .cmd wrappers
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: workDir,
			env: { ...process.env, ...env },
			stdio: [stdinContent ? "pipe" : "ignore", "pipe", "pipe"],
			shell: isWindows, // Required on Windows for npm global commands (.cmd wrappers)
		});

		// Write stdin content if provided
		if (stdinContent && proc.stdin) {
			proc.stdin.write(stdinContent);
			proc.stdin.end();
		}

		let stdoutBuffer = "";
		let stderrBuffer = "";

		const processBuffer = (buffer: string, isStderr = false) => {
			const lines = buffer.split("\n");
			const remaining = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line);
			}
			return remaining;
		};

		proc.stdout?.on("data", (data) => {
			stdoutBuffer += data.toString();
			stdoutBuffer = processBuffer(stdoutBuffer);
		});

		proc.stderr?.on("data", (data) => {
			stderrBuffer += data.toString();
			stderrBuffer = processBuffer(stderrBuffer, true);
		});

		proc.on("close", (exitCode) => {
			// Process any remaining data
			if (stdoutBuffer.trim()) onLine(stdoutBuffer);
			if (stderrBuffer.trim()) onLine(stderrBuffer);
			resolve({ exitCode: exitCode ?? 1 });
		});

		proc.on("error", (err) => {
			// Maintain backward compatibility - don't reject, report error via onLine
			onLine(`Spawn error: ${err.message}`);
			resolve({ exitCode: 1 });
		});
	});
}

/**
 * Check if a file path looks like a test file
 */
function isTestFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return (
		lower.includes(".test.") ||
		lower.includes(".spec.") ||
		lower.includes("__tests__") ||
		lower.includes("_test.go")
	);
}

/**
 * Truncate a string to a maximum length with ellipsis
 */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Format a file path for display (show last 60 chars)
 */
function formatFilePath(filePath: string): string {
	return truncate(filePath, 60);
}

/**
 * Format a command for display (truncate to 50 chars)
 */
function formatCommand(command: string): string {
	return `Running: ${truncate(command, 50)}`;
}

/**
 * Extract tool info from Claude's stream-json format
 * Claude format: { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "..." } }] } }
 */
function extractToolFromClaudeFormat(parsed: Record<string, unknown>): {
	toolName: string;
	filePath: string;
	command: string;
} | null {
	if (parsed.type !== "assistant") return null;

	const message = parsed.message as Record<string, unknown> | undefined;
	if (!message?.content) return null;

	const content = message.content as Array<Record<string, unknown>>;
	if (!Array.isArray(content)) return null;

	// Find tool_use in content array
	for (const item of content) {
		if (item.type === "tool_use" && item.name) {
			const toolName = (item.name as string).toLowerCase();
			const input = (item.input as Record<string, unknown>) || {};
			const filePath = ((input.file_path || input.path || "") as string).toLowerCase();
			const command = ((input.command || "") as string).toLowerCase();
			return { toolName, filePath, command };
		}
	}

	return null;
}

/**
 * Detect the current step from a JSON output line
 * Returns step info including step name and optional tool output
 */
export function detectStepFromOutput(line: string): StepInfo | null {
	// Fast path: skip non-JSON lines
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed);

		// Try Claude's stream-json format first (nested in message.content)
		const claudeTool = extractToolFromClaudeFormat(parsed);

		let toolName = "";
		let filePath = "";
		let command = "";
		let description = "";

		if (claudeTool) {
			toolName = claudeTool.toolName;
			filePath = claudeTool.filePath;
			command = claudeTool.command;
		} else {
			// Fallback: Extract from flat structure (other engines)
			toolName =
				parsed.tool?.toLowerCase() ||
				parsed.name?.toLowerCase() ||
				parsed.tool_name?.toLowerCase() ||
				"";
			command = parsed.command?.toLowerCase() || "";
			filePath = (parsed.file_path || parsed.filePath || parsed.path || "").toLowerCase();
			description = (parsed.description || "").toLowerCase();
		}

		// No tool detected
		if (!toolName && !command) {
			return null;
		}

		// Check tool name first to determine operation type
		const isReadOperation = toolName === "read" || toolName === "glob" || toolName === "grep";
		const isWriteOperation = toolName === "write" || toolName === "edit";
		const isBashOperation = toolName === "bash";

		// Reading code
		if (isReadOperation) {
			const toolOutput = filePath ? formatFilePath(filePath) : undefined;
			return { step: "Reading code", toolOutput };
		}

		// Bash command detection
		if (isBashOperation || command) {
			// Git commit
			if (command.includes("git commit") || description.includes("git commit")) {
				return { step: "Committing" };
			}

			// Git add/staging
			if (command.includes("git add") || description.includes("git add")) {
				return { step: "Staging" };
			}

			// Linting - check command for lint tools
			if (
				command.includes("lint") ||
				command.includes("eslint") ||
				command.includes("biome") ||
				command.includes("prettier")
			) {
				const rawCommand = claudeTool?.command || parsed.command || "";
				const toolOutput = rawCommand ? formatCommand(rawCommand) : undefined;
				return { step: "Linting", toolOutput };
			}

			// Testing - check command for test runners
			if (
				command.includes("vitest") ||
				command.includes("jest") ||
				command.includes("bun test") ||
				command.includes("npm test") ||
				command.includes("pytest") ||
				command.includes("go test")
			) {
				const rawCommand = claudeTool?.command || parsed.command || "";
				const toolOutput = rawCommand ? formatCommand(rawCommand) : undefined;
				return { step: "Testing", toolOutput };
			}

			// Generic bash command - show what's running
			if (isBashOperation && command) {
				const rawCommand = claudeTool?.command || parsed.command || "";
				const toolOutput = rawCommand ? formatCommand(rawCommand) : undefined;
				return { step: "Running command", toolOutput };
			}
		}

		// Writing tests - only for write operations to test files
		if (isWriteOperation && isTestFile(filePath)) {
			const toolOutput = filePath ? formatFilePath(filePath) : undefined;
			return { step: "Writing tests", toolOutput };
		}

		// Writing/Editing code
		if (isWriteOperation) {
			const toolOutput = filePath ? formatFilePath(filePath) : undefined;
			return { step: "Implementing", toolOutput };
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Base implementation for AI engines
 */
export abstract class BaseAIEngine implements AIEngine {
	abstract name: string;
	abstract cliCommand: string;

	async isAvailable(): Promise<boolean> {
		return commandExists(this.cliCommand);
	}

	abstract execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult>;

	/**
	 * Execute with streaming progress updates (optional implementation)
	 */
	executeStreaming?(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult>;
}
