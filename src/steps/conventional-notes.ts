import { defineStep } from "../define.ts";
import { z } from "../options.ts";
import type { Change } from "../types.ts";
import {
	mentionsBreaking,
	parseTitle,
	type Title,
} from "../utils/conventional.ts";

/**
 * A `## Title` section for breaking changes, then one per group of
 * conventional types, then the rest.
 */
export const conventionalNotes = defineStep({
	type: "release-notes",
	name: "conventional-notes",
	description:
		"`## Breaking Changes`, `## Features`, `## Bug Fixes`, `## Performance Improvements` and `## Reverts` sections, then `## Other` for everything else.",
	options: {
		sections: z
			.array(
				z.strictObject({
					title: z.string(),
					types: z.array(z.string()).describe("`type` or `type(scope)`"),
				}),
			)
			.default([
				{ title: "Features", types: ["feat"] },
				{ title: "Bug Fixes", types: ["fix"] },
				{ title: "Performance Improvements", types: ["perf"] },
				{ title: "Reverts", types: ["revert"] },
			])
			.describe(
				"Sections in order; a change goes in the first that lists its type.",
			),
		breaking: z
			.union([z.string(), z.literal(false)])
			.default("Breaking Changes")
			.describe(
				"The first section, for breaking changes of any type; `false` marks them **(breaking)** in their own section instead.",
			),
		other: z
			.union([z.string(), z.literal(false)])
			.default("Other")
			.describe("The section for remaining changes; `false` leaves them out."),
		links: z
			.boolean()
			.default(true)
			.describe("Link each change to its source, e.g. its commit."),
	},
	run: ({ changes, kind, options }) => {
		const section = (title: string, types: readonly string[] = []) => ({
			title,
			types,
			entries: [] as string[],
		});
		const breaking =
			options.breaking === false ? undefined : section(options.breaking);
		const other = options.other === false ? undefined : section(options.other);
		const typed = options.sections.map(({ title, types }) =>
			section(title, types),
		);
		for (const change of changes) {
			const title = change.title ? parseTitle(change.title) : undefined;
			const isBreaking =
				title?.breaking ||
				mentionsBreaking(change.title) ||
				mentionsBreaking(change.description);
			const target =
				(isBreaking ? breaking : undefined) ??
				(title && typed.find((s) => matches(title, s.types))) ??
				other;
			if (!target) continue;
			const entry = format(change, title, {
				marker: isBreaking && target !== breaking,
				link: options.links,
			});
			if (entry !== undefined) target.entries.push(entry);
		}

		const sections = [breaking, ...typed, other].filter((s) => s !== undefined);
		const filled = sections.filter(({ entries }) => entries.length > 0);
		const notes = filled
			.map(({ title, entries }) => `## ${title}\n\n${entries.join("\n")}`)
			.join("\n\n");
		const counts = filled.map(
			({ title, entries }) => `${title.toLowerCase()}: ${entries.length}`,
		);
		return {
			notes,
			reason: `${kind} release; ${counts.join(", ") || "no entries"}`,
		};
	},
});

function matches(title: Title, types: readonly string[]): boolean {
	return (
		types.includes(title.type) ||
		(title.scope !== undefined &&
			types.includes(`${title.type}(${title.scope})`))
	);
}

function format(
	change: Change,
	parsed: Title | undefined,
	style: { marker: boolean; link: boolean },
): string | undefined {
	const text = parsed
		? `${parsed.scope ? `**${parsed.scope}:** ` : ""}${parsed.subject}`
		: (change.title ?? change.description?.split("\n")[0])?.trim();
	if (!text) return undefined;
	const marker = style.marker ? " **(breaking)**" : "";
	const link =
		style.link && change.link
			? ` ([${change.link.label}](${change.link.url}))`
			: "";
	return `- ${text}${marker}${link}`;
}
