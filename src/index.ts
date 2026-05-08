import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const STATUS_KEY = "gh-bot";
const AUTH_WIDGET_KEY = "gh-bot-auth";
const DEFAULT_CONFIG_DIR = "~/.config/gh-bot";
const EXPECTED_LOGIN_ENV_KEY = "PI_GH_BOT_EXPECTED_LOGIN";
const AUTH_HOSTNAME = "github.com";
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_KILL_GRACE_MS = 5_000;
const MAX_AUTH_OUTPUT_CHARS = 8_000;
const TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

type GitHubBotEnvironment = {
	configDir: string;
	expectedLogin?: string;
};

type GitHubBotStatus = GitHubBotEnvironment & {
	login?: string;
	actualLogin?: string;
	error?: string;
};

type AuthResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	output: string;
	timedOut: boolean;
};

type AuthDisplayState = {
	code?: string;
	url?: string;
	lastLines: string[];
};

export function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}

	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}

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
	for (const key of TOKEN_ENV_KEYS) {
		delete env[key];
	}
}

function applyGitHubBotEnvironment(): GitHubBotEnvironment {
	const configDir = getConfiguredBotDir();
	const expectedLogin = getExpectedLogin();

	process.env.GH_CONFIG_DIR = configDir;
	process.env.GH_PROMPT_DISABLED = "1";
	removeTokenEnvironment(process.env);

	return { configDir, expectedLogin };
}

function quarantineGitHubConfigDir(configDir: string): void {
	process.env.GH_CONFIG_DIR = resolve(configDir, ".blocked-unexpected-login");
	process.env.GH_PROMPT_DISABLED = "1";
	removeTokenEnvironment(process.env);
}

export function getAuthEnvironment(configDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: configDir };
	removeTokenEnvironment(env);
	delete env.GH_PROMPT_DISABLED;
	return env;
}

function summarizeGhFailure(result: ExecResult): string {
	const stderr = result.stderr.trim();
	if (stderr) {
		return stderr;
	}

	const stdout = result.stdout.trim();
	if (stdout) {
		return stdout;
	}

	return `gh exited with code ${result.code}`;
}

function loginMatchesExpected(actualLogin: string, expectedLogin: string): boolean {
	return actualLogin.toLowerCase() === expectedLogin.toLowerCase();
}

export async function readActiveLogin(pi: ExtensionAPI, cwd: string): Promise<GitHubBotStatus> {
	const env = applyGitHubBotEnvironment();

	let result: ExecResult;
	try {
		result = await pi.exec("gh", ["api", "user", "--jq", ".login"], { cwd, timeout: 10_000 });
	} catch (error) {
		return {
			...env,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const actualLogin = result.stdout.trim();
	if (result.code === 0 && actualLogin) {
		if (env.expectedLogin && !loginMatchesExpected(actualLogin, env.expectedLogin)) {
			quarantineGitHubConfigDir(env.configDir);
			return {
				...env,
				actualLogin,
				error: `Authenticated as ${actualLogin}, expected ${env.expectedLogin}. Refusing to use this GitHub identity.`,
			};
		}

		return { ...env, login: actualLogin, actualLogin };
	}

	return {
		...env,
		error: summarizeGhFailure(result),
	};
}

export function statusText(status: GitHubBotStatus): string {
	if (status.login) {
		return `gh:${status.login}`;
	}

	if (status.actualLogin && status.expectedLogin) {
		return "gh:wrong-account";
	}

	return "gh:auth-missing";
}

function commandMessage(status: GitHubBotStatus): string {
	const lines = [statusText(status), `GH_CONFIG_DIR=${status.configDir}`];
	if (status.expectedLogin) {
		lines.push(`expected=${status.expectedLogin}`);
	}
	if (status.actualLogin && status.actualLogin !== status.login) {
		lines.push(`actual=${status.actualLogin}`);
	}
	if (status.error) {
		lines.push(`error=${status.error}`);
	}
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

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function appendLimited(existing: string, next: string): string {
	const combined = existing + next;
	return combined.length > MAX_AUTH_OUTPUT_CHARS ? combined.slice(-MAX_AUTH_OUTPUT_CHARS) : combined;
}

export function extractDeviceCode(text: string): string | undefined {
	return text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
}

export function extractDeviceUrl(text: string): string | undefined {
	return text.match(/https:\/\/github\.com\/login\/device\S*/)?.[0];
}

function authWidgetLines(state: AuthDisplayState): string[] {
	const lines = [
		"GitHub bot auth in progress",
		"Use the BOT GitHub account in browser, not your personal account.",
		"If GitHub shows your personal session, switch account or use incognito logged in as bot before entering code.",
		"GH_CONFIG_DIR stores the CLI token; browser still chooses which GitHub account grants it.",
	];

	if (state.code) {
		lines.push(`Code: ${state.code}`);
	} else {
		lines.push("Code: waiting for gh...");
	}

	if (state.url) {
		lines.push(`URL: ${state.url}`);
	} else {
		lines.push("URL: waiting for gh...");
	}

	if (state.lastLines.length > 0) {
		lines.push("", ...state.lastLines.slice(-4).map((line) => `gh: ${line}`));
	}

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

async function runWebAuth(ctx: ExtensionContext, configDir: string): Promise<AuthResult> {
	await mkdir(configDir, { recursive: true });

	const displayState: AuthDisplayState = { lastLines: [] };
	const seen: { code?: string; url?: string } = {};
	updateAuthWidget(ctx, displayState);

	const args = [
		"auth",
		"login",
		"--hostname",
		AUTH_HOSTNAME,
		"--web",
		"--clipboard",
		"--git-protocol",
		"https",
		"--skip-ssh-key",
	];

	return new Promise<AuthResult>((resolveAuth, rejectAuth) => {
		const child = spawn("gh", args, {
			cwd: ctx.cwd,
			env: getAuthEnvironment(configDir),
			stdio: ["pipe", "pipe", "pipe"],
		});

		let output = "";
		let timedOut = false;
		let killTimeout: NodeJS.Timeout | undefined;
		const lineState = { buffer: "" };
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => child.kill("SIGKILL"), AUTH_KILL_GRACE_MS);
		}, AUTH_TIMEOUT_MS);

		child.once("error", (error) => {
			clearTimeout(timeout);
			if (killTimeout) {
				clearTimeout(killTimeout);
			}
			rejectAuth(error);
		});

		const onOutput = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output = appendLimited(output, text);
			notifyAuthOutput(ctx, text, lineState, displayState, seen);
		};

		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);

		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (killTimeout) {
				clearTimeout(killTimeout);
			}
			flushAuthOutput(ctx, lineState, displayState);
			applyGitHubBotEnvironment();
			resolveAuth({ code, signal, output: stripAnsi(output).trim(), timedOut });
		});

		child.stdin?.write("\n");
		child.stdin?.end();
	});
}

function authFailureMessage(result: AuthResult): string {
	if (result.timedOut) {
		return "gh auth timed out before browser flow completed.";
	}

	const detail = result.output || `exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
	return `gh auth failed: ${detail}`;
}

applyGitHubBotEnvironment();

export default function githubBotExtension(pi: ExtensionAPI): void {
	async function refresh(ctx: ExtensionContext): Promise<GitHubBotStatus> {
		const status = await readActiveLogin(pi, ctx.cwd);
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
		if (!proceed) {
			return refresh(ctx);
		}

		const env = applyGitHubBotEnvironment();
		ctx.ui.notify(
			`Starting GitHub browser auth for ${AUTH_HOSTNAME}. Use bot GitHub account. Code and URL will stay visible above editor.`,
			"info",
		);

		let authResult: AuthResult;
		try {
			authResult = await runWebAuth(ctx, env.configDir);
		} catch (error) {
			applyGitHubBotEnvironment();
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
		if (!status.login) {
			ctx.ui.notify(commandMessage(status), "warning");
		}
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
			if (startAuth) {
				await authenticate(ctx);
			} else {
				ctx.ui.notify(commandMessage(status), "warning");
			}
		},
	});
}
