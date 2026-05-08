const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createJiti } = require("jiti");

const jiti = createJiti(process.cwd() + "/");
const extension = jiti("./src/index.ts");

const ENV_KEYS = [
	"GH_CONFIG_DIR",
	"GH_PROMPT_DISABLED",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"PI_GH_BOT_CONFIG_DIR",
	"PI_GH_BOT_EXPECTED_LOGIN",
	"PI_GH_BOT_AUTO_GUARD",
	"PATH",
];

function restoreEnvAfter(fn) {
	const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	return async () => {
		try {
			await fn();
		} finally {
			for (const [key, value] of snapshot) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
}

function addFakeGh(script) {
	const binDir = mkdtempSync(join(tmpdir(), "gh-bot-bin-"));
	const fakeGh = join(binDir, "gh");
	writeFileSync(fakeGh, script);
	chmodSync(fakeGh, 0o755);
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	return binDir;
}

test(
	"expandHome expands only leading home shorthand",
	restoreEnvAfter(() => {
		assert.equal(extension.expandHome("~"), homedir());
		assert.equal(extension.expandHome("~/gh-bot"), resolve(homedir(), "gh-bot"));
		assert.equal(extension.expandHome("/tmp/gh-bot"), "/tmp/gh-bot");
	}),
);

test(
	"token env stripping and auth env removes prompt disable",
	restoreEnvAfter(() => {
		const env = {
			GH_TOKEN: "a",
			GITHUB_TOKEN: "b",
			GH_ENTERPRISE_TOKEN: "c",
			GITHUB_ENTERPRISE_TOKEN: "d",
			OTHER: "keep",
		};

		extension.removeTokenEnvironment(env);
		assert.equal(env.GH_TOKEN, undefined);
		assert.equal(env.GITHUB_TOKEN, undefined);
		assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
		assert.equal(env.GITHUB_ENTERPRISE_TOKEN, undefined);
		assert.equal(env.OTHER, "keep");

		process.env.GH_TOKEN = "token";
		process.env.GH_PROMPT_DISABLED = "1";
		const authEnv = extension.getAuthEnvironment("/tmp/gh-bot");
		assert.equal(authEnv.GH_CONFIG_DIR, "/tmp/gh-bot");
		assert.equal(authEnv.GH_TOKEN, undefined);
		assert.equal(authEnv.GH_PROMPT_DISABLED, undefined);

		const botEnv = extension.getBotEnvironment("/tmp/gh-bot");
		assert.equal(botEnv.GH_PROMPT_DISABLED, "1");
	}),
);

test(
	"device auth output parsing finds code and URL",
	restoreEnvAfter(() => {
		const output = [
			"! One-time code (BF77-9647) copied to clipboard",
			"Open this URL to continue in your web browser: https://github.com/login/device",
		].join("\n");

		assert.equal(extension.extractDeviceCode(output), "BF77-9647");
		assert.equal(extension.extractDeviceUrl(output), "https://github.com/login/device");
	}),
);

test(
	"expected login mismatch fails closed without mutating process gh env",
	restoreEnvAfter(async () => {
		const configDir = mkdtempSync(join(tmpdir(), "gh-bot-config-"));
		const binDir = addFakeGh("#!/usr/bin/env bash\nprintf 'personal-user\\n'\n");
		try {
			process.env.PI_GH_BOT_CONFIG_DIR = configDir;
			process.env.PI_GH_BOT_EXPECTED_LOGIN = "bot-user";
			process.env.GH_CONFIG_DIR = "/tmp/user-gh";

			const status = await extension.readActiveLogin(process.cwd());

			assert.equal(status.login, undefined);
			assert.equal(status.actualLogin, "personal-user");
			assert.equal(status.expectedLogin, "bot-user");
			assert.equal(extension.statusText(status), "gh: wrong-account");
			assert.match(status.error, /Refusing to use this GitHub identity/);
			assert.equal(process.env.GH_CONFIG_DIR, "/tmp/user-gh");
		} finally {
			rmSync(binDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	}),
);

test(
	"auth failure clears auth widget",
	restoreEnvAfter(async () => {
		const configDir = mkdtempSync(join(tmpdir(), "gh-bot-config-"));
		const binDir = addFakeGh(
			[
				"#!/usr/bin/env bash",
				"printf '! One-time code (BF77-9647) copied to clipboard\\n' >&2",
				"printf 'Open this URL to continue in your web browser: https://github.com/login/device\\n' >&2",
				"read -r _ || true",
				"exit 1",
				"",
			].join("\n"),
		);
		try {
			process.env.PI_GH_BOT_CONFIG_DIR = configDir;
			delete process.env.PI_GH_BOT_EXPECTED_LOGIN;

			const commands = {};
			extension.default({
				on() {},
				registerTool() {},
				registerCommand(name, command) {
					commands[name] = command;
				},
			});

			const widgets = [];
			const ctx = {
				cwd: process.cwd(),
				ui: {
					setStatus() {},
					setWidget(key, content, options) {
						widgets.push({ key, content, options });
					},
					notify() {},
					async confirm() {
						return true;
					},
				},
			};

			await commands["gh-bot-auth"].handler("", ctx);

			assert.ok(
				widgets.some(
					(widget) => Array.isArray(widget.content) && widget.content.some((line) => line.includes("BF77-9647")),
				),
			);
			assert.deepEqual(widgets.at(-1), { key: "gh-bot-auth", content: undefined, options: undefined });
		} finally {
			rmSync(binDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	}),
);

test(
	"visible GitHub write classification targets comments and reviews",
	restoreEnvAfter(() => {
		assert.equal(extension.classifyVisibleGitHubWrite("gh issue comment 1 --body hi"), "GitHub issue comment");
		assert.equal(extension.classifyVisibleGitHubWrite("gh pr comment 2 --body hi"), "GitHub PR comment");
		assert.equal(extension.classifyVisibleGitHubWrite("gh pr review 2 --comment --body hi"), "GitHub PR review/comment");
		assert.equal(
			extension.classifyVisibleGitHubWrite("gh api repos/o/r/issues/1/comments -f body=hi"),
			"GitHub API comment/review mutation",
		);
		assert.equal(extension.classifyVisibleGitHubWrite("gh pr view 2 --json title"), undefined);
		assert.equal(extension.classifyVisibleGitHubWrite("git commit -m hi"), undefined);
	}),
);

test(
	"bash guard blocks visible gh comments and points to gh_bot",
	restoreEnvAfter(async () => {
		delete process.env.PI_GH_BOT_AUTO_GUARD;
		const handlers = {};
		extension.default({
			on(name, handler) {
				handlers[name] = handler;
			},
			registerTool() {},
			registerCommand() {},
		});

		const result = await handlers.tool_call(
			{ toolName: "bash", input: { command: "gh issue comment 1 --body hi" } },
			{},
		);
		assert.equal(result.block, true);
		assert.match(result.reason, /gh_bot/);

		process.env.PI_GH_BOT_AUTO_GUARD = "0";
		const disabled = await handlers.tool_call(
			{ toolName: "bash", input: { command: "gh issue comment 1 --body hi" } },
			{},
		);
		assert.equal(disabled, undefined);
	}),
);

test(
	"gh_bot tool runs gh with bot config but does not mutate process gh env",
	restoreEnvAfter(async () => {
		const configDir = mkdtempSync(join(tmpdir(), "gh-bot-config-"));
		const logFile = join(tmpdir(), `gh-bot-env-${Date.now()}.log`);
		const binDir = addFakeGh(
			[
				"#!/usr/bin/env bash",
				`printf '%s\\n' \"$GH_CONFIG_DIR|$GH_TOKEN|$GH_PROMPT_DISABLED|$*\" >> ${JSON.stringify(logFile)}`,
				"if [ \"$1 $2 $3 $4\" = 'api user --jq .login' ]; then printf 'bot-user\\n'; exit 0; fi",
				"printf 'ran:%s\\n' \"$*\"",
				"",
			].join("\n"),
		);
		try {
			process.env.PI_GH_BOT_CONFIG_DIR = configDir;
			process.env.PI_GH_BOT_EXPECTED_LOGIN = "bot-user";
			process.env.GH_CONFIG_DIR = "/tmp/user-gh";
			process.env.GH_TOKEN = "user-token";

			let tool;
			extension.default({
				on() {},
				registerCommand() {},
				registerTool(definition) {
					if (definition.name === "gh_bot") tool = definition;
				},
			});

			const result = await tool.execute("tool-1", { args: ["issue", "comment", "1", "--body", "hello"] }, undefined, undefined, {
				cwd: process.cwd(),
			});

			assert.match(result.content[0].text, /gh_bot as bot-user/);
			assert.match(result.content[0].text, /ran:issue comment 1 --body hello/);
			assert.equal(process.env.GH_CONFIG_DIR, "/tmp/user-gh");
			assert.equal(process.env.GH_TOKEN, "user-token");
		} finally {
			rmSync(binDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
			rmSync(logFile, { force: true });
		}
	}),
);
