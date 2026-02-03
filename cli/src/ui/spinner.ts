import { createSpinner } from "nanospinner";
import pc from "picocolors";
import type { DiffInfo, TodoItem } from "../engines/types.ts";
import { formatDuration } from "./logger.ts";

export type SpinnerInstance = ReturnType<typeof createSpinner>;

/**
 * Operation timing entry for tracking step durations
 */
interface OperationTiming {
	name: string;
	startTime: number;
	endTime?: number;
}

/**
 * Progress spinner with step tracking and operation timing
 *
 * Features:
 * - Shows current step with elapsed time
 * - Tracks step transitions for performance visibility
 * - Optional operation timing breakdown in success message
 */
export class ProgressSpinner {
	private spinner: SpinnerInstance;
	private startTime: number;
	private currentStep = "Thinking";
	private task: string;
	private settings: string;
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private stepHistory: OperationTiming[] = [];
	private stepStartTime: number;
	private toolOutput: string | null = null;
	private codeSnippet: string[] | null = null;
	private diff: DiffInfo | null = null;
	private todos: TodoItem[] = [];

	constructor(task: string, settings?: string[]) {
		this.task = task.length > 40 ? `${task.slice(0, 37)}...` : task;
		this.settings = settings?.length ? `[${settings.join(", ")}]` : "";
		this.startTime = Date.now();
		this.stepStartTime = Date.now();
		this.spinner = createSpinner(this.formatText()).start();

		// Record initial step
		this.stepHistory.push({ name: this.currentStep, startTime: this.stepStartTime });

		// Update timer every second
		this.tickInterval = setInterval(() => this.tick(), 1000);
	}

	private formatText(): string {
		const elapsed = Date.now() - this.startTime;
		const time = formatDuration(elapsed);
		const lines: string[] = [];

		if (this.todos.length > 0) {
			lines.push(pc.dim("─".repeat(50)));
			lines.push(pc.bold("Todos:"));
			for (const todo of this.todos) {
				const icon = todo.status === "completed" ? pc.green("✓") : todo.status === "in_progress" ? pc.yellow("●") : pc.dim("○");
				const text = todo.status === "completed" ? pc.dim(todo.content) : todo.content;
				lines.push(`  ${icon} ${text}`);
			}
			lines.push(pc.dim("─".repeat(50)));
		}

		const settingsStr = this.settings ? ` ${pc.yellow(this.settings)}` : "";
		lines.push(`${pc.cyan(this.currentStep)}${settingsStr} ${pc.dim(`[${time}]`)} ${this.task}`);

		if (this.diff) {
			lines.push("");
			lines.push(`  ${pc.dim("─")} Edit ${pc.cyan(this.diff.filePath)}`);
			const startLine = this.diff.startLine || 1;
			if (this.diff.oldLines && this.diff.oldLines.length > 0) {
				for (let i = 0; i < this.diff.oldLines.length; i++) {
					const lineNum = String(startLine + i).padStart(3, " ");
					lines.push(`  ${pc.dim(lineNum)} ${pc.red("-")} ${pc.red(this.diff.oldLines[i])}`);
				}
			}
			if (this.diff.newLines && this.diff.newLines.length > 0) {
				for (let i = 0; i < this.diff.newLines.length; i++) {
					const lineNum = String(startLine + i).padStart(3, " ");
					lines.push(`  ${pc.dim(lineNum)} ${pc.green("+")} ${pc.green(this.diff.newLines[i])}`);
				}
			}
		} else if (this.toolOutput) {
			lines.push(`  ${pc.dim("└─")} ${pc.dim(this.toolOutput)}`);
			if (this.codeSnippet && this.codeSnippet.length > 0) {
				for (let i = 0; i < this.codeSnippet.length; i++) {
					const lineNum = String(i + 1).padStart(3, " ");
					lines.push(`  ${pc.dim(lineNum)} ${pc.green("+")} ${pc.green(this.codeSnippet[i])}`);
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Update the current step and record timing
	 */
	updateStep(step: string): void {
		const now = Date.now();

		// Close out previous step timing
		if (this.stepHistory.length > 0) {
			const lastStep = this.stepHistory[this.stepHistory.length - 1];
			if (!lastStep.endTime) {
				lastStep.endTime = now;
			}
		}

		// Record new step
		this.currentStep = step;
		this.stepStartTime = now;
		this.stepHistory.push({ name: step, startTime: now });

		this.spinner.update({ text: this.formatText() });
	}

	updateToolOutput(output: string | null, codeSnippet?: string[] | null, diff?: DiffInfo | null, todos?: TodoItem[]): void {
		this.toolOutput = output;
		this.codeSnippet = codeSnippet || null;
		this.diff = diff || null;
		if (todos) this.todos = todos;
		this.spinner.update({ text: this.formatText() });
	}

	/**
	 * Update spinner text (called periodically to update time)
	 */
	tick(): void {
		this.spinner.update({ text: this.formatText() });
	}

	private clearTickInterval(): void {
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
	}

	/**
	 * Get total elapsed time in milliseconds
	 */
	getElapsedMs(): number {
		return Date.now() - this.startTime;
	}

	/**
	 * Get step timing breakdown
	 */
	getStepTimings(): Array<{ name: string; durationMs: number }> {
		const now = Date.now();
		return this.stepHistory.map((step) => ({
			name: step.name,
			durationMs: (step.endTime || now) - step.startTime,
		}));
	}

	/**
	 * Mark as success with optional timing breakdown
	 */
	success(message?: string, showTimingBreakdown = false): void {
		this.clearTickInterval();
		const elapsed = formatDuration(this.getElapsedMs());

		let text = message || this.formatText();

		if (showTimingBreakdown && this.stepHistory.length > 1) {
			const timings = this.getStepTimings()
				.filter((t) => t.durationMs >= 1000) // Only show steps that took >= 1s
				.map((t) => `${t.name}: ${formatDuration(t.durationMs)}`)
				.join(", ");
			if (timings) {
				text = `${text} ${pc.dim(`(${timings})`)}`;
			}
		}

		this.spinner.success({ text: `${text} ${pc.green(`[${elapsed}]`)}` });
	}

	/**
	 * Mark as error
	 */
	error(message?: string): void {
		this.clearTickInterval();
		const elapsed = formatDuration(this.getElapsedMs());
		this.spinner.error({ text: `${message || this.formatText()} ${pc.red(`[${elapsed}]`)}` });
	}

	/**
	 * Stop the spinner
	 */
	stop(): void {
		this.clearTickInterval();
		this.spinner.stop();
	}
}

/**
 * Create a simple spinner
 */
export function createSimpleSpinner(text: string): SpinnerInstance {
	return createSpinner(text).start();
}

/**
 * Simple operation timer for tracking specific operations
 */
export class OperationTimer {
	private startTime: number;
	private operationName: string;

	constructor(operationName: string) {
		this.operationName = operationName;
		this.startTime = Date.now();
	}

	/**
	 * Get elapsed time in milliseconds
	 */
	elapsedMs(): number {
		return Date.now() - this.startTime;
	}

	/**
	 * Get formatted elapsed time
	 */
	elapsed(): string {
		return formatDuration(this.elapsedMs());
	}

	/**
	 * Get operation name and elapsed time
	 */
	summary(): string {
		return `${this.operationName}: ${this.elapsed()}`;
	}
}
