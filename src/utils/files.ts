import { glob, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolves globs, relative to `cwd` unless absolute, to the absolute paths of
 * the files they match, sorted; a directory stands for every file in it.
 * Every pattern must match something, so a typo fails instead of uploading
 * nothing.
 */
export async function resolveFiles(
	cwd: string,
	patterns: readonly string[],
): Promise<string[]> {
	const files = new Set<string>();
	for (const pattern of patterns) {
		// Forward slashes work on Windows too, where a backslash would escape.
		const normalized = pattern.replaceAll("\\", "/");
		let matched = false;
		for await (const match of glob(normalized, { cwd })) {
			matched = true;
			const path = isAbsolute(match) ? match : resolve(cwd, match);
			for (const file of await filesIn(path)) files.add(file);
		}
		if (!matched) throw new Error(`no files match '${pattern}'`);
	}
	return [...files].sort();
}

async function filesIn(path: string): Promise<string[]> {
	if (!(await stat(path)).isDirectory()) return [path];
	const entries = await readdir(path, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

/** `1.2 MB`, `340 kB`, `12 B`. */
export function formatSize(bytes: number): string {
	const units = ["B", "kB", "MB", "GB"];
	let size = bytes;
	let unit = 0;
	while (size >= 1000 && unit < units.length - 1) {
		size /= 1000;
		unit++;
	}
	return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}
