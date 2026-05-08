import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";

const STATUS_KEY = "gh-bot";
const AUTH_WIDGET_KEY = "gh-bot-auth";
const DEFAULT_CONFIG_DIR = "~/.config/gh-bot";
const EXPECTED_LOGIN_ENV_KEY = "PI_GH_BOT_EXPECTED_LOGIN";
const AUTH_HOSTNAME = "github.com";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_CHARS = 12_000;
const TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

type GitHubBotStatus = {
	configDir: string;
	expectedLogin?: string;
	login?: string;
	actualLogin?: string;
	error?: string;
};

type ProcessResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
};

type AuthDisplayState = {
	code?: string;
	url?: string;
	lastLines: string[];
};

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function getConfiguredBotDir(): string {
	return expandHome(process.env.PI_GH_BOT_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR);
}

function getExpectedLogin(): string | undefined {
	const login = process.env[EXPECTED_LOGIN_ENV_KEY]?.trim();
	return login || undefined;
}

export function removeTokenEnvironment(env: NodeJS.ProcessEnv): void {
	for (const key of TOKEN_ENV_KEYS) delete env[key];
}

export function getBotEnvironment(configDir = getConfiguredBotDir(), promptDisabled = true): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: configDir };
	removeTokenEnvironment(env);
	if (promptDisabled) env.GH_PROMPT_DISABLED = "1";
	else delete env.GH_PROMPT_DISABLED;
	return env;
}

export function getAuthEnvironment(configDir: string): NodeJS.ProcessEnv {
	return getBotEnvironment(configDir, false);
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function appendLimited(existing: string, next: string): string {
	const combined = existing + next;
	return combined.length > MAX_OUTPUT_CHARS ? combined.slice(-MAX_OUTPUT_CHARS) : combined;
}

export function extractDeviceCode(text: string): string | undefined {
	return text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
}

export function extractDeviceUrl(text: string): string | undefined {
	return text.match(/https:\/\/github\.com\/login\/device\S*/)?.[0];
}

function loginMatchesExpected(actualLogin: string, expectedLogin: string): boolean {
	return actualLogin.toLowerCase() === expectedLogin.toLowerCase();
}

function summarizeFailure(result: ProcessResult): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	if (result.timedOut) return "timed out";
	return `exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
}

function runProcess(options: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	input?: string;
	onOutput?: (chunk: string) => void;
}): Promise<ProcessResult> {
	return new Promise<ProcessResult>((resolveResult, rejectResult) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimeout: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		}, options.timeoutMs);

		child.once("error", (error) => {
			clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			rejectResult(error);
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout = appendLimited(stdout, text);
			options.onOutput?.(text);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr = appendLimited(stderr, text);
			options.onOutput?.(text);
		});

		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolveResult({ stdout: stripAnsi(stdout).trimEnd(), stderr: stripAnsi(stderr).trimEnd(), code, signal, timedOut });
		});

		if (options.input !== undefined) child.stdin?.write(options.input);
		child.stdin?.end();
	});
}

async function runGhBot(args: string[], cwd: string, promptDisabled = true, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ProcessResult> {
	return runProcess({
		command: "gh",
		args,
		cwd,
		env: getBotEnvironment(getConfiguredBotDir(), promptDisabled),
		timeoutMs,
	});
}

export async function readActiveLogin(cwd: string): Promise<GitHubBotStatus> {
	const configDir = getConfiguredBotDir();
	const expectedLogin = getExpectedLogin();

	let result: ProcessResult;
	try {
		result = await runGhBot(["api", "user", "--jq", ".login"], cwd);
	} catch (error) {
		return { configDir, expectedLogin, error: error instanceof Error ? error.message : String(error) };
	}

	const actualLogin = result.stdout.trim();
	if (result.code === 0 && actualLogin) {
		if (expectedLogin && !loginMatchesExpected(actualLogin, expectedLogin)) {
			return {
				configDir,
				expectedLogin,
				actualLogin,
				error: `Authenticated as ${actualLogin}, expected ${expectedLogin}. Refusing to use this GitHub identity.`,
			};
		}

		return { configDir, expectedLogin, login: actualLogin, actualLogin };
	}

	return { configDir, expectedLogin, error: summarizeFailure(result) };
}

export function statusText(status: GitHubBotStatus): string {
	if (status.login) return `gh: ${status.login}`;
	if (status.actualLogin && status.expectedLogin) return "gh: wrong-account";
	return "gh: auth-missing";
}

function commandMessage(status: GitHubBotStatus): string {
	const lines = [statusText(status), `GH_CONFIG_DIR=${status.configDir}`];
	if (status.expectedLogin) lines.push(`expected=${status.expectedLogin}`);
	if (status.actualLogin && status.actualLogin !== status.login) lines.push(`actual=${status.actualLogin}`);
	if (status.error) lines.push(`error=${status.error}`);
	if (!status.login) {
		lines.push(
			status.actualLogin && status.expectedLogin
				? "Run /gh-bot-auth after switching browser auth to expected bot account."
				: "Run /gh-bot-auth to start browser auth.",
		);
	}
	return lines.join("\n");
}

function updateUiStatus(ctx: ExtensionContext, status: GitHubBotStatus): void {
	ctx.ui.setStatus(STATUS_KEY, statusText(status));
}

function authWidgetLines(state: AuthDisplayState): string[] {
	const lines = [
		"GitHub bot auth in progress",
		"Use the BOT GitHub account in browser, not your personal account.",
		"If GitHub shows your personal session, switch account or use incognito logged in as bot before entering code.",
		"GH_CONFIG_DIR stores the CLI token; browser still chooses which GitHub account grants it.",
	];
	lines.push(state.code ? `Code: ${state.code}` : "Code: waiting for gh...");
	lines.push(state.url ? `URL: ${state.url}` : "URL: waiting for gh...");
	if (state.lastLines.length > 0) lines.push("", ...state.lastLines.slice(-4).map((line) => `gh: ${line}`));
	return lines;
}

function updateAuthWidget(ctx: ExtensionContext, state: AuthDisplayState): void {
	ctx.ui.setWidget(AUTH_WIDGET_KEY, authWidgetLines(state), { placement: "aboveEditor" });
}

export function clearAuthWidget(ctx: Pick<ExtensionContext, "ui">): void {
	ctx.ui.setWidget(AUTH_WIDGET_KEY, undefined);
}

function notifyAuthOutput(
	ctx: ExtensionContext,
	chunk: string,
	lineState: { buffer: string },
	displayState: AuthDisplayState,
	seen: { code?: string; url?: string },
): void {
	const cleanChunk = stripAnsi(chunk);
	const code = extractDeviceCode(cleanChunk);
	if (code && code !== seen.code) {
		seen.code = code;
		displayState.code = code;
		ctx.ui.notify(`GitHub bot auth code: ${code} (also copied to clipboard by gh)`, "info");
	}

	const url = extractDeviceUrl(cleanChunk);
	if (url && url !== seen.url) {
		seen.url = url;
		displayState.url = url;
		ctx.ui.notify(`GitHub bot auth URL: ${url}`, "info");
	}

	lineState.buffer += cleanChunk.replace(/\r/g, "\n");
	const lines = lineState.buffer.split("\n");
	lineState.buffer = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) {
			displayState.lastLines.push(trimmed);
			ctx.ui.notify(`gh auth: ${trimmed}`, "info");
		}
	}
	updateAuthWidget(ctx, displayState);
}

function flushAuthOutput(ctx: ExtensionContext, lineState: { buffer: string }, displayState: AuthDisplayState): void {
	const trimmed = lineState.buffer.trim();
	if (trimmed) {
		displayState.lastLines.push(trimmed);
		ctx.ui.notify(`gh auth: ${trimmed}`, "info");
	}
	lineState.buffer = "";
	updateAuthWidget(ctx, displayState);
}

async function runWebAuth(ctx: ExtensionContext, configDir: string): Promise<ProcessResult> {
	await mkdir(configDir, { recursive: true });
	const displayState: AuthDisplayState = { lastLines: [] };
	const seen: { code?: string; url?: string } = {};
	const lineState = { buffer: "" };
	updateAuthWidget(ctx, displayState);

	const result = await runProcess({
		command: "gh",
		args: [
			"auth",
			"login",
			"--hostname",
			AUTH_HOSTNAME,
			"--web",
			"--clipboard",
			"--git-protocol",
			"https",
			"--skip-ssh-key",
		],
		cwd: ctx.cwd,
		env: getBotEnvironment(configDir, false),
		timeoutMs: AUTH_TIMEOUT_MS,
		input: "\n",
		onOutput: (chunk) => notifyAuthOutput(ctx, chunk, lineState, displayState, seen),
	});
	flushAuthOutput(ctx, lineState, displayState);
	return result;
}

function authFailureMessage(result: ProcessResult): string {
	if (result.timedOut) return "gh auth timed out before browser flow completed.";
	return `gh auth failed: ${summarizeFailure(result)}`;
}

function formatGhBotResult(args: string[], status: GitHubBotStatus, result: ProcessResult): string {
	const lines = [`gh_bot as ${status.login}`, `command: gh ${args.join(" ")}`, `exit=${result.code ?? "unknown"}`];
	if (result.signal) lines.push(`signal=${result.signal}`);
	if (result.timedOut) lines.push("timedOut=true");
	if (result.stdout.trim()) lines.push("", "stdout:", result.stdout.trim());
	if (result.stderr.trim()) lines.push("", "stderr:", result.stderr.trim());
	return lines.join("\n");
}

export default function githubBotExtension(pi: ExtensionAPI): void {
	async function refresh(ctx: ExtensionContext): Promise<GitHubBotStatus> {
		const status = await readActiveLogin(ctx.cwd);
		updateUiStatus(ctx, status);
		return status;
	}

	async function authenticate(ctx: ExtensionContext): Promise<GitHubBotStatus> {
		clearAuthWidget(ctx);
		const proceed = await ctx.ui.confirm(
			"GitHub bot auth",
			[
				`This opens ${AUTH_HOSTNAME} device auth in your browser.`,
				"Authorize with the BOT GitHub account, not your personal account.",
				"If browser is already signed in as you, switch account or use incognito before entering the code.",
			].join("\n"),
		);
		if (!proceed) return refresh(ctx);

		const configDir = getConfiguredBotDir();
		ctx.ui.notify(
			`Starting GitHub browser auth for ${AUTH_HOSTNAME}. Use bot GitHub account. Code and URL will stay visible above editor.`,
			"info",
		);

		let authResult: ProcessResult;
		try {
			authResult = await runWebAuth(ctx, configDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`gh auth failed: ${message}`, "error");
			return refresh(ctx);
		} finally {
			clearAuthWidget(ctx);
		}

		if (authResult.code !== 0) {
			ctx.ui.notify(authFailureMessage(authResult), "error");
			return refresh(ctx);
		}

		const status = await refresh(ctx);
		ctx.ui.notify(commandMessage(status), status.login ? "info" : "warning");
		return status;
	}

	pi.on("session_start", async (_event, ctx) => {
		const status = await refresh(ctx);
		if (!status.login) ctx.ui.notify(commandMessage(status), "warning");
	});

	pi.registerTool({
		name: "gh_bot",
		label: "GitHub Bot",
		description:
			"Run GitHub CLI as the isolated bot identity. Use for GitHub issue/PR comments, review comments, replies, and other visible GitHub actions that should come from the bot account. Args are gh arguments without the leading 'gh'.",
		promptSnippet: "Run GitHub CLI as the bot identity for issue/PR comments, review comments, and replies.",
		promptGuidelines: [
			"Use gh_bot instead of bash gh when creating GitHub issue comments, PR review comments, review replies, or other visible GitHub actions that should appear from the bot account.",
			"Do not use gh_bot for local Git commands or authentication; use /gh-bot-auth when bot auth is missing.",
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: "Arguments to pass to gh, excluding the leading gh." }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to Pi cwd." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const status = await readActiveLogin(cwd);
			if (!status.login) throw new Error(commandMessage(status));

			const result = await runGhBot(params.args, cwd);
			const text = formatGhBotResult(params.args, status, result);
			if (result.code !== 0) throw new Error(text);

			return {
				content: [{ type: "text", text }],
				details: {
					args: params.args,
					cwd,
					login: status.login,
					configDir: status.configDir,
					stdout: result.stdout,
					stderr: result.stderr,
					code: result.code,
					signal: result.signal,
					timedOut: result.timedOut,
				},
			};
		},
	});

	pi.registerCommand("gh-bot-auth", {
		description: "Authenticate the GitHub bot account with browser OAuth",
		handler: async (_args, ctx) => {
			await authenticate(ctx);
		},
	});

	pi.registerCommand("gh-bot-status", {
		description: "Show active GitHub bot login and GH_CONFIG_DIR",
		handler: async (_args, ctx) => {
			const status = await refresh(ctx);
			if (status.login) {
				ctx.ui.notify(commandMessage(status), "info");
				return;
			}

			const startAuth = await ctx.ui.confirm("GitHub bot auth missing", `${commandMessage(status)}\n\nStart browser auth now?`);
			if (startAuth) await authenticate(ctx);
			else ctx.ui.notify(commandMessage(status), "warning");
		},
	});
}
