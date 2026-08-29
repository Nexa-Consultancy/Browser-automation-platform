// Deterministic parser: turns an English instruction line into a typed
// ParsedStep the worker's stepExecutor can run with zero ambiguity. Every
// pattern below is a fixed grammar (regex), not an LLM guess — the same
// line always parses to the same action.

export type ParsedStep =
  | { kind: "open"; url: string; raw: string }
  | { kind: "click"; target: string; raw: string }
  | { kind: "fill"; field: string; value: string; raw: string }
  | { kind: "type"; text: string; raw: string }
  | { kind: "select"; field: string; option: string; raw: string }
  | { kind: "check"; field: string; raw: string }
  | { kind: "uncheck"; field: string; raw: string }
  | { kind: "press"; key: string; raw: string }
  | { kind: "wait_text"; text: string; raw: string }
  | { kind: "wait_seconds"; seconds: number; raw: string }
  | { kind: "wait_video"; raw: string }
  | { kind: "wait_element"; selector: string; raw: string }
  | { kind: "screenshot"; raw: string }
  | { kind: "unknown"; raw: string };

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray, raw: string) => ParsedStep }> = [
  {
    re: /^(?:open|go to|navigate to)\s+(.+)$/i,
    build: (m, raw) => ({ kind: "open", url: stripQuotes(m[1]), raw }),
  },
  {
    re: /^wait for video(?:\s+to\s+(?:end|finish))?$/i,
    build: (_m, raw) => ({ kind: "wait_video", raw }),
  },
  {
    re: /^wait (?:for )?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)$/i,
    build: (m, raw) => ({ kind: "wait_seconds", seconds: Number(m[1]), raw }),
  },
  {
    re: /^wait for text\s+(.+)$/i,
    build: (m, raw) => ({ kind: "wait_text", text: stripQuotes(m[1]), raw }),
  },
  {
    re: /^wait for element\s+(.+)$/i,
    build: (m, raw) => ({ kind: "wait_element", selector: stripQuotes(m[1]), raw }),
  },
  {
    re: /^fill\s+(.+?)\s+with\s+(.+)$/i,
    build: (m, raw) => ({ kind: "fill", field: stripQuotes(m[1]), value: stripQuotes(m[2]), raw }),
  },
  {
    re: /^(?:select)\s+(.+?)\s+(?:in|from)\s+(.+)$/i,
    build: (m, raw) => ({ kind: "select", option: stripQuotes(m[1]), field: stripQuotes(m[2]), raw }),
  },
  {
    re: /^check\s+(.+)$/i,
    build: (m, raw) => ({ kind: "check", field: stripQuotes(m[1]), raw }),
  },
  {
    re: /^uncheck\s+(.+)$/i,
    build: (m, raw) => ({ kind: "uncheck", field: stripQuotes(m[1]), raw }),
  },
  {
    re: /^press\s+(.+)$/i,
    build: (m, raw) => ({ kind: "press", key: stripQuotes(m[1]), raw }),
  },
  {
    re: /^screenshot$/i,
    build: (_m, raw) => ({ kind: "screenshot", raw }),
  },
  {
    re: /^type\s+(.+)$/i,
    build: (m, raw) => ({ kind: "type", text: stripQuotes(m[1]), raw }),
  },
  {
    re: /^click\s+(.+)$/i,
    build: (m, raw) => ({ kind: "click", target: stripQuotes(m[1]), raw }),
  },
];

export function parseStep(line: string): ParsedStep {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return { kind: "unknown", raw };
  for (const { re, build } of PATTERNS) {
    const m = raw.match(re);
    if (m) return build(m, raw);
  }
  return { kind: "unknown", raw };
}

export function parseSteps(lines: string[]): ParsedStep[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map(parseStep);
}

/**
 * Substitutes {{column}} (or {column}) placeholders with values from a
 * user's CSV row. Both brace styles are accepted since people naturally
 * type either — matching is case-insensitive against row keys so
 * "{{Email}}", "{{email}}" and "{email}" all resolve against a column
 * literally named either way.
 */
export function applyTemplate(text: string, row: Record<string, string>): string {
  const lowerRow = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}/g, (all, doubleKey?: string, singleKey?: string) => {
    const key = doubleKey ?? singleKey ?? "";
    const val = lowerRow.get(key.toLowerCase());
    return val !== undefined ? val : all;
  });
}
