import {
	BaseAIEngine,
	checkForErrors,
	execCommand,
	execCommandStreaming,
	formatCommandError,
} from "./base.ts";
import type { AIResult, DiffInfo, EngineOptions, ProgressCallback, StepInfo, TodoItem } from "./types.ts";

const isWindows = process.platform === "win32";

/**
 * OpenCode AI Engine
 */
export class OpenCodeEngine extends BaseAIEngine {
	name = "OpenCode";
	cliCommand = "opencode";

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		const args = ["run", "--format", "json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}
		// Add any additional engine-specific arguments
		if (options?.engineArgs && options.engineArgs.length > 0) {
			args.push(...options.engineArgs);
		}

		// On Windows, pass prompt via stdin to avoid cmd.exe argument parsing issues with multi-line content
		let stdinContent: string | undefined;
		if (isWindows) {
			stdinContent = prompt;
		} else {
			args.push(prompt);
		}

		const { stdout, stderr, exitCode } = await execCommand(
			this.cliCommand,
			args,
			workDir,
			{ OPENCODE_PERMISSION: '{"*":"allow"}' },
			stdinContent,
		);

		const output = stdout + stderr;

		// Check for errors
		const error = checkForErrors(output);
		if (error) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error,
			};
		}

		// Parse OpenCode JSON format
		const { response, inputTokens, outputTokens, cost } = this.parseOutput(output);

		// If command failed with non-zero exit code, provide a meaningful error
		if (exitCode !== 0) {
			return {
				success: false,
				response,
				inputTokens,
				outputTokens,
				error: formatCommandError(exitCode, output),
			};
		}

		return {
			success: true,
			response,
			inputTokens,
			outputTokens,
			cost,
		};
	}

	async executeStreaming(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult> {
		const args = ["run", "--format", "json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}
		if (options?.engineArgs && options.engineArgs.length > 0) {
			args.push(...options.engineArgs);
		}

		let stdinContent: string | undefined;
		if (isWindows) {
			stdinContent = prompt;
		} else {
			args.push(prompt);
		}

		const outputLines: string[] = [];

		const { exitCode } = await execCommandStreaming(
			this.cliCommand,
			args,
			workDir,
			(line) => {
				outputLines.push(line);
				const stepInfo = this.detectStepFromLine(line);
				if (stepInfo) {
					onProgress(stepInfo);
				}
			},
			{ OPENCODE_PERMISSION: '{"*":"allow"}' },
			stdinContent,
		);

		const output = outputLines.join("\n");

		const error = checkForErrors(output);
		if (error) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error,
			};
		}

		const { response, inputTokens, outputTokens, cost } = this.parseOutput(output);

		if (exitCode !== 0) {
			return {
				success: false,
				response,
				inputTokens,
				outputTokens,
				error: formatCommandError(exitCode, output),
			};
		}

		return {
			success: true,
			response,
			inputTokens,
			outputTokens,
			cost,
		};
	}

	private currentTodos: TodoItem[] = [];

	private detectStepFromLine(line: string): StepInfo | null {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return null;

		try {
			const parsed = JSON.parse(trimmed);

			if (parsed.type === "tool_call" && parsed.part?.name) {
				const toolName = parsed.part.name.toLowerCase();
				const input = parsed.part.input || {};

				if (toolName === "todowrite" || toolName === "mcp_todowrite") {
					if (input.todos && Array.isArray(input.todos)) {
						this.currentTodos = (input.todos as Array<Record<string, unknown>>).map((t) => ({
							id: String(t.id || ""),
							content: String(t.content || ""),
							status: (t.status as "pending" | "in_progress" | "completed") || "pending",
						}));
						return { step: "Planning", todos: this.currentTodos };
					}
				}

				const rawFilePath = (input.file_path || input.path || "") as string;
				const filePath = rawFilePath.toLowerCase();
				const command = (input.command || "").toLowerCase();
				const oldContent = (input.old_string || input.oldString || "") as string;
				const newContent = (input.content || input.new_string || input.newString || "") as string;

				if (toolName === "read" || toolName === "glob" || toolName === "grep") {
					return {
						step: "Reading code",
						toolOutput: filePath ? this.truncatePath(filePath) : undefined,
						todos: this.currentTodos.length > 0 ? this.currentTodos : undefined,
					};
				}

				if (toolName === "write" || toolName === "edit") {
					const isTest = this.isTestFile(filePath);
					const diff = this.createDiff(rawFilePath, oldContent, newContent);
					return {
						step: isTest ? "Writing tests" : "Implementing",
						diff,
						todos: this.currentTodos.length > 0 ? this.currentTodos : undefined,
					};
				}

				if (toolName === "bash") {
					if (command.includes("git commit")) return { step: "Committing", todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
					if (command.includes("git add")) return { step: "Staging", todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
					if (command.includes("lint") || command.includes("eslint") || command.includes("biome")) {
						return { step: "Linting", toolOutput: command ? `Running: ${this.truncate(command, 50)}` : undefined, todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
					}
					if (command.includes("test") || command.includes("vitest") || command.includes("jest")) {
						return { step: "Testing", toolOutput: command ? `Running: ${this.truncate(command, 50)}` : undefined, todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
					}
					return { step: "Running command", toolOutput: command ? `Running: ${this.truncate(command, 50)}` : undefined, todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
				}
			}

			if (parsed.type === "step_start") {
				return { step: "Thinking", todos: this.currentTodos.length > 0 ? this.currentTodos : undefined };
			}

			return null;
		} catch {
			return null;
		}
	}

	private createDiff(filePath: string, oldContent: string, newContent: string, maxLines = 4): DiffInfo | undefined {
		if (!newContent && !oldContent) return undefined;
		const oldLines = oldContent ? oldContent.split("\n").slice(0, maxLines).map((l) => this.truncate(l, 70)) : undefined;
		const newLines = newContent ? newContent.split("\n").slice(0, maxLines).map((l) => this.truncate(l, 70)) : undefined;
		return { filePath, oldLines, newLines };
	}

	private truncate(str: string, maxLen: number): string {
		if (str.length <= maxLen) return str;
		return `${str.slice(0, maxLen - 3)}...`;
	}

	private truncatePath(filePath: string): string {
		return this.truncate(filePath, 60);
	}

	private isTestFile(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return lower.includes(".test.") || lower.includes(".spec.") || lower.includes("__tests__");
	}

	private extractCodeSnippet(code: string, maxLines = 3): string[] {
		if (!code) return [];
		const lines = code.split("\n").filter((l) => l.trim());
		return lines.slice(0, maxLines).map((line) => this.truncate(line.trim(), 60));
	}

	private parseOutput(output: string): {
		response: string;
		inputTokens: number;
		outputTokens: number;
		cost?: string;
	} {
		const lines = output.split("\n").filter(Boolean);
		let response = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let cost: string | undefined;

		// Find step_finish for token counts
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === "step_finish") {
					inputTokens = parsed.part?.tokens?.input || 0;
					outputTokens = parsed.part?.tokens?.output || 0;
					if (parsed.part?.cost) {
						cost = String(parsed.part.cost);
					}
				}
			} catch {
				// Ignore non-JSON lines
			}
		}

		// Get text response from text events
		const textParts: string[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === "text" && parsed.part?.text) {
					textParts.push(parsed.part.text);
				}
			} catch {
				// Ignore non-JSON lines
			}
		}

		response = textParts.join("") || "Task completed";

		return { response, inputTokens, outputTokens, cost };
	}
}
