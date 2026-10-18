import type { StepInput, StepType } from "./types.ts";

/**
 * What an `if:` expression can read: the release so far, as the step itself
 * would receive it.
 */
export interface ExpressionContext {
	dryRun: boolean;
	branch: string;
	cwd: string;
	previousVersion?: string;
	previousRef?: string;
	changes?: readonly unknown[];
	kind?: string;
	version?: string;
	notes?: string;
	/** The steps that ran before, by name: `{ type, status, reason, output }`. */
	steps: Record<string, unknown>;
}

const NAMES: readonly (keyof ExpressionContext)[] = [
	"dryRun",
	"branch",
	"cwd",
	"previousVersion",
	"previousRef",
	"changes",
	"kind",
	"version",
	"notes",
	"steps",
];

export function expressionContext(
	input: StepInput<StepType>,
): ExpressionContext {
	const results = input as Partial<Record<string, unknown>>;
	return {
		dryRun: input.env.dryRun,
		branch: input.env.branch,
		cwd: input.env.cwd,
		...Object.fromEntries(
			(
				[
					"previousVersion",
					"previousRef",
					"changes",
					"kind",
					"version",
					"notes",
				] as const
			).flatMap((name) =>
				results[name] === undefined ? [] : [[name, results[name]]],
			),
		),
		steps: Object.fromEntries(
			input.history.map((record) => [
				record.name,
				{
					type: record.type,
					status: record.status,
					reason: record.reason,
					output:
						record.type === "release"
							? (record.output as { output?: unknown } | undefined)?.output
							: record.output,
				},
			]),
		),
	};
}

export class ExpressionError extends Error {
	override name = "ExpressionError";
}

type Node = (context: ExpressionContext) => unknown;

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
	contains: (search, item) =>
		Array.isArray(search)
			? search.includes(item)
			: String(search ?? "").includes(String(item ?? "")),
	startsWith: (text, prefix) =>
		String(text ?? "").startsWith(String(prefix ?? "")),
	endsWith: (text, suffix) => String(text ?? "").endsWith(String(suffix ?? "")),
};

const TOKEN =
	/\s*(?:(\d+(?:\.\d+)?)|'((?:[^']|'')*)'|([A-Za-z_][\w-]*)|(==|!=|<=|>=|&&|\|\||[!<>().[\],]))/y;

type Token =
	| { kind: "number"; value: number }
	| { kind: "string"; value: string }
	| { kind: "name"; value: string }
	| { kind: "op"; value: string };

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	TOKEN.lastIndex = 0;
	while (source.slice(TOKEN.lastIndex).trim() !== "") {
		const at = TOKEN.lastIndex;
		const match = TOKEN.exec(source);
		if (!match) {
			throw new ExpressionError(
				`unexpected '${source.slice(at).trim()[0]}' at ${source.length - source.slice(at).trimStart().length + 1}`,
			);
		}
		const [, number, string, name, op] = match;
		if (number !== undefined)
			tokens.push({ kind: "number", value: Number(number) });
		else if (string !== undefined)
			tokens.push({ kind: "string", value: string.replaceAll("''", "'") });
		else if (name !== undefined) tokens.push({ kind: "name", value: name });
		else tokens.push({ kind: "op", value: op ?? "" });
	}
	return tokens;
}

/**
 * Compiles an `if:` expression, in the style of GitHub's: literals (`true`,
 * `'text'`, `1`, `null`), names from {@link ExpressionContext} with `.x` and
 * `['x']` access, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`,
 * parentheses, and `contains`, `startsWith` and `endsWith`.
 */
export function compileExpression(source: string): Node {
	const tokens = tokenize(source);
	let position = 0;
	const peek = () => tokens[position];
	const isOp = (value: string) => {
		const token = peek();
		return token?.kind === "op" && token.value === value;
	};
	const expect = (value: string) => {
		if (!isOp(value)) throw unexpected();
		position++;
	};
	const unexpected = () => {
		const token = peek();
		return new ExpressionError(
			token ? `unexpected '${token.value}'` : "unexpected end",
		);
	};

	const binary = (
		next: () => Node,
		operators: Record<string, (a: unknown, b: () => unknown) => unknown>,
	) => {
		return (): Node => {
			let left = next();
			for (;;) {
				const token = peek();
				const apply = token?.kind === "op" ? operators[token.value] : undefined;
				if (!apply) return left;
				position++;
				const right = next();
				const l = left;
				left = (context) => apply(l(context), () => right(context));
			}
		};
	};

	const compare =
		(test: (a: number | string, b: number | string) => boolean) =>
		(a: unknown, b: () => unknown) => {
			const right = b();
			return (
				(typeof a === "number" || typeof a === "string") &&
				typeof right === typeof a &&
				test(a, right as number | string)
			);
		};

	const primary = (): Node => {
		const token = peek();
		if (!token) throw unexpected();
		position++;
		if (token.kind === "number" || token.kind === "string") {
			return () => token.value;
		}
		if (token.kind === "op") {
			if (token.value === "!") {
				const operand = primary();
				return (context) => !operand(context);
			}
			if (token.value === "(") {
				const inner = or();
				expect(")");
				return inner;
			}
			position--;
			throw unexpected();
		}
		const literals: Record<string, unknown> = {
			true: true,
			false: false,
			null: null,
		};
		if (token.value in literals) return () => literals[token.value];
		if (isOp("(")) {
			const fn = FUNCTIONS[token.value];
			if (!fn) {
				throw new ExpressionError(
					`unknown function '${token.value}'; use ${Object.keys(FUNCTIONS).join(", ")}`,
				);
			}
			position++;
			const args: Node[] = [];
			if (!isOp(")")) {
				args.push(or());
				while (isOp(",")) {
					position++;
					args.push(or());
				}
			}
			expect(")");
			return (context) => fn(...args.map((arg) => arg(context)));
		}
		if (!(NAMES as readonly string[]).includes(token.value)) {
			throw new ExpressionError(
				`unknown name '${token.value}'; use ${NAMES.join(", ")}`,
			);
		}
		const name = token.value as keyof ExpressionContext;
		let node: Node = (context) => context[name];
		for (;;) {
			if (isOp(".")) {
				position++;
				const key = peek();
				if (key?.kind !== "name") throw unexpected();
				position++;
				const object = node;
				node = (context) => property(object(context), key.value);
			} else if (isOp("[")) {
				position++;
				const key = or();
				expect("]");
				const object = node;
				node = (context) => property(object(context), key(context));
			} else {
				return node;
			}
		}
	};

	const comparison = binary(primary, {
		"<": compare((a, b) => a < b),
		"<=": compare((a, b) => a <= b),
		">": compare((a, b) => a > b),
		">=": compare((a, b) => a >= b),
	});
	const equality = binary(comparison, {
		"==": (a, b) => (a ?? null) === (b() ?? null),
		"!=": (a, b) => (a ?? null) !== (b() ?? null),
	});
	const and = binary(equality, { "&&": (a, b) => (a ? b() : a) });
	const or: () => Node = binary(and, { "||": (a, b) => a || b() });

	if (tokens.length === 0) throw new ExpressionError("empty expression");
	const root = or();
	if (position < tokens.length) throw unexpected();
	return root;
}

function property(object: unknown, key: unknown): unknown {
	if (typeof object !== "object" || object === null) return undefined;
	const name = String(key);
	return Object.hasOwn(object, name)
		? (object as Record<string, unknown>)[name]
		: undefined;
}
