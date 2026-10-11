import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";

import { compileAgentBrowserJob } from "../extensions/agent-browser/lib/input-modes/job.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const invalidSelects = [
	{ action: "select", locator: "label", value: "Flavor", values: ["chocolate"] },
	{ action: "select", locator: "role", role: "combobox", name: "Flavor", value: "chocolate" },
	{ action: "select", selector: "#flavor", locator: "label", value: "Flavor", values: ["chocolate"] },
	{ action: "select", selector: "#flavor", value: "chocolate", values: ["vanilla"] },
	{ action: "select", selector: "#flavor" },
	{ action: "select", selector: "#flavor", values: [] },
	{ action: "select", selector: "", value: "chocolate" },
];

test("registered job schema discriminates selector select from semantic label/role select", () => {
	const { tool } = createExtensionHarness({ cwd: tmpdir() });
	for (const step of invalidSelects) {
		const job = { steps: [{ action: "open", url: "https://shop.example.test/" }, step] };
		assert.equal(Check(tool.parameters, { job }), false, JSON.stringify(step));
		const result = compileAgentBrowserJob(job);
		assert.ok(result.error, JSON.stringify(step));
		assert.equal(result.compiled, undefined);
	}
	for (const step of [
		{ action: "select", selector: "#flavor", value: "chocolate" },
		{ action: "select", selector: "@e4", values: ["vanilla", "chocolate"] },
	]) {
		assert.equal(Check(tool.parameters, { job: { steps: [step] } }), true);
		assert.deepEqual(compileAgentBrowserJob({ steps: [step] }).compiled?.steps[0]?.args,
			["select", step.selector, ...(step.values ?? [step.value])]);
	}
	for (const semanticAction of [
		{ action: "select", locator: "label", value: "Flavor", values: ["chocolate"] },
		{ action: "select", locator: "role", role: "combobox", name: "Flavor", value: "chocolate" },
	]) assert.equal(Check(tool.parameters, { semanticAction }), true);
	assert.equal(Check(tool.parameters, { job: { steps: [{ action: "click", locator: "label", value: "Flavor" }] } }), true);
	assert.equal(Check(tool.parameters, { job: { steps: [{ action: "snapshot", selector: "body" }] } }), false);
});

test("invalid select jobs dispatch nothing, while semantic select rejects ambiguous current refs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-job-select-contract-"));
	const logPath = join(tempDir, "invocations.log");
	const ambiguousPath = join(tempDir, "ambiguous");
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
if (args.includes("batch")) stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
let data = "ok";
if (args.includes("open")) data = { title: "Shop", url: "https://shop.example.test/" };
else if (args.includes("snapshot")) {
  const refs = { e4: { role: "combobox", name: "Flavor" } };
  if (fs.existsSync(${JSON.stringify(ambiguousPath)})) refs.e5 = { role: "combobox", name: "Flavor" };
  data = { origin: "https://shop.example.test/", refs, snapshot: Object.keys(refs).map(ref => '- combobox "Flavor" [ref=' + ref + ']').join("\\n") };
} else if (args.includes("batch")) data = JSON.parse(stdin).map(command => ({ command, success: true, result: { selected: command.at(-1) } }));
else if (args.includes("select")) data = { selected: args.at(-1) };
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const step of invalidSelects) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					job: { steps: [{ action: "open", url: "https://shop.example.test/" }, step] },
				});
				assert.equal(result.isError, true, JSON.stringify(step));
			}
			assert.deepEqual(await readInvocationLog(logPath), []);
			const selected = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "select", selector: "#flavor", value: "chocolate" }] },
			});
			assert.equal(selected.isError, false, JSON.stringify(selected));
			assert.deepEqual((await readInvocationLog(logPath)).filter(row => row.args.includes("batch")).map(row => JSON.parse(row.stdin ?? "")),
				[[["select", "#flavor", "chocolate"]]]);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://shop.example.test/"] })).isError, false);
			const targets = [
				{ action: "select", locator: "label", value: "Flavor", values: ["chocolate"] },
				{ action: "select", locator: "role", role: "combobox", name: "Flavor", value: "chocolate" },
			];
			for (const semanticAction of targets) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction });
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.deepEqual((result.details?.effectiveArgs as string[]).slice(-3), ["select", "@e4", "chocolate"]);
			}
			const before = await readInvocationLog(logPath);
			await writeFile(ambiguousPath, "yes");
			for (const semanticAction of targets) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction });
				assert.equal(result.isError, true);
				assert.match(result.details?.validationError as string, /exactly one current visible/);
			}
			const after = await readInvocationLog(logPath);
			assert.equal(after.filter(row => row.args.includes("select")).length, before.filter(row => row.args.includes("select")).length);
			assert.equal(after.some(row => row.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
