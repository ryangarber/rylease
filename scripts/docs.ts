/**
 * Generates the options reference of the bundled steps in README.md from their
 * definitions. Run with `pnpm gen:docs`; `--check` fails if README.md is stale.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { AnyStepFactory } from "../src/define.ts";
import { z } from "../src/options.ts";
import { conventional } from "../src/presets/index.ts";
import * as steps from "../src/steps/index.ts";

interface Schema {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	anyOf?: Schema[];
	items?: Schema;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: Schema | boolean;
	default?: unknown;
	description?: string;
}

const README = new URL("../README.md", import.meta.url);
const START = "<!-- options:start -->";
const END = "<!-- options:end -->";

function typeOf(schema: Schema): string {
	if (schema.anyOf) return schema.anyOf.map(typeOf).join(" \\| ");
	if (schema.const !== undefined) return flow(schema.const);
	if (schema.enum) return schema.enum.map(flow).join(" \\| ");
	if (schema.type === "array" && schema.items) {
		return `${typeOf(schema.items)}[]`;
	}
	if (schema.type === "object" && schema.properties) {
		const fields = Object.entries(schema.properties).map(
			([key, value]) =>
				`${key}${schema.required?.includes(key) ? "" : "?"}: ${typeOf(value)}`,
		);
		return `{ ${fields.join(", ")} }`;
	}
	if (
		schema.type === "object" &&
		typeof schema.additionalProperties === "object"
	) {
		return `{ [key]: ${typeOf(schema.additionalProperties)} }`;
	}
	return schema.type ?? "unknown";
}

/** YAML flow style, as the value would be written in a workflow. */
function flow(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).map(([k, v]) => `${k}: ${flow(v)}`);
		return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
	}
	return String(value);
}

function reference(): string {
	const others = Object.values(steps).filter(
		(step) => !conventional.steps.some((other) => other.name === step.name),
	);
	const section = (step: AnyStepFactory) => {
		const schema = z.toJSONSchema(z.object(step.options), {
			io: "input",
		}) as Schema;
		const options = Object.entries(schema.properties ?? {});
		const heading = `#### \`${step.name}\` · \`${step.type}\`\n\n${step.description ?? ""}`;
		if (options.length === 0) return `${heading}\n\nNo options.`;
		const rows = options.map(([name, option]) => {
			const fallback =
				option.default !== undefined
					? `\`${flow(option.default)}\``
					: schema.required?.includes(name)
						? "required"
						: "";
			return `| \`${name}\` | \`${typeOf(option)}\` | ${fallback} | ${option.description ?? ""} |`;
		});
		return [
			heading,
			"",
			"| Option | Type | Default | |",
			"|---|---|---|---|",
			...rows,
		].join("\n");
	};
	const sections = [
		...conventional.steps.map(section),
		"### More steps\n\nThese aren't in `conventional`; list them after it.",
		...others.map(section),
	];
	return `${START}\n${sections.join("\n\n")}\n${END}`;
}

const readme = await readFile(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1) throw new Error(`README.md has no ${START}`);
const updated =
	readme.slice(0, start) + reference() + readme.slice(end + END.length);

if (process.argv.includes("--check")) {
	if (updated !== readme) {
		console.error("README.md is out of date; run `pnpm gen:docs`");
		process.exitCode = 1;
	}
} else {
	await writeFile(README, updated);
}
