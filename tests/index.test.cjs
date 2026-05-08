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
	"PATH",
];

function restoreEnvAfter(fn) {
	const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	return async () => {
		try {
			await fn();
		} finally {
			for (const [key, value] of snapshot) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	};
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
	"expected login mismatch fails closed and quarantines GH_CONFIG_DIR",
	restoreEnvAfter(async () => {
		const configDir = mkdtempSync(join(tmpdir(), "gh-bot-config-"));
		try {
			process.env.PI_GH_BOT_CONFIG_DIR = configDir;
			process.env.PI_GH_BOT_EXPECTED_LOGIN = "bot-user";

			const status = await extension.readActiveLogin(
				{
					async exec() {
						return { stdout: "personal-user\n", stderr: "", code: 0, killed: false };
					},
				},
				process.cwd(),
			);

			assert.equal(status.login, undefined);
			assert.equal(status.actualLogin, "personal-user");
			assert.equal(status.expectedLogin, "bot-user");
			assert.equal(extension.statusText(status), "gh:wrong-account");
			assert.match(status.error, /Refusing to use this GitHub identity/);
			assert.equal(process.env.GH_CONFIG_DIR, resolve(configDir, ".blocked-unexpected-login"));
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	}),
);

test(
	"auth failure clears auth widget",
	restoreEnvAfter(async () => {
		const binDir = mkdtempSync(join(tmpdir(), "gh-bot-bin-"));
		const configDir = mkdtempSync(join(tmpdir(), "gh-bot-config-"));
		try {
			const fakeGh = join(binDir, "gh");
			writeFileSync(
				fakeGh,
				[
					"#!/usr/bin/env bash",
					"printf '! One-time code (BF77-9647) copied to clipboard\\n' >&2",
					"printf 'Open this URL to continue in your web browser: https://github.com/login/device\\n' >&2",
					"read -r _ || true",
					"exit 1",
					"",
				].join("\n"),
			);
			chmodSync(fakeGh, 0o755);

			process.env.PATH = `${binDir}:${process.env.PATH}`;
			process.env.PI_GH_BOT_CONFIG_DIR = configDir;
			delete process.env.PI_GH_BOT_EXPECTED_LOGIN;

			const commands = {};
			extension.default({
				on() {},
				registerCommand(name, command) {
					commands[name] = command;
				},
				async exec() {
					return { stdout: "", stderr: "not logged in", code: 1, killed: false };
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
