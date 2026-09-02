import Papa from "papaparse";

export interface CsvUserRow {
  userName: string;
  data: Record<string, string>;
}

/**
 * Parses a per-user CSV. Any column can be referenced from a step as
 * {{columnName}}. A column named "name"/"user"/"username" (case-insensitive)
 * is used as the display name for that user's box on the dashboard; if none
 * is present we fall back to "User 1", "User 2", ...
 */
export function parseUserCsv(csvText: string): CsvUserRow[] {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (result.errors.length > 0) {
    const first = result.errors[0];
    throw new Error(`CSV parse error at row ${first.row}: ${first.message}`);
  }

  const nameKeyCandidates = ["name", "user", "username", "user name"];

  return result.data.map((row, idx) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k) cleaned[k.trim()] = (v ?? "").toString().trim();
    }
    const nameKey = Object.keys(cleaned).find((k) => nameKeyCandidates.includes(k.toLowerCase()));
    const userName = (nameKey ? cleaned[nameKey] : "") || `User ${idx + 1}`;
    // Whatever column the display name came from (or the "User N" fallback),
    // always also expose it as {{name}} — that's the one users naturally
    // type in a step even when their CSV calls the column something else.
    if (!("name" in cleaned) && !Object.keys(cleaned).some((k) => k.toLowerCase() === "name")) {
      cleaned.name = userName;
    }
    return { userName, data: cleaned };
  });
}

/**
 * Named users with no CSV: one name per user (from the dashboard's "Names"
 * field), exposed as {{name}} just like a CSV's name column would be.
 */
export function buildNamedUsers(names: string[]): CsvUserRow[] {
  return names.map((name) => ({ userName: name, data: { name } }));
}

/**
 * One row per linked, reusable User (see PlatformUser) — carries userId so
 * the worker's profilePlanFor routes the session to that user's own
 * persistent, already-authenticated profile dir instead of any group or
 * master dir. {{name}} and {{email}} are also exposed for use in steps.
 */
export function buildLinkedUsers(users: { id: string; name: string; email: string }[]): CsvUserRow[] {
  return users.map((u) => ({ userName: u.name, data: { name: u.name, email: u.email, userId: u.id } }));
}

/** No CSV and no names supplied: synthesize N generically-named rows.
 * {{name}} still resolves (to "User 1", "User 2", ...) so a step script
 * written for named users doesn't just print the literal placeholder. */
export function buildDefaultUsers(count: number): CsvUserRow[] {
  return Array.from({ length: count }, (_, i) => {
    const userName = `User ${i + 1}`;
    return { userName, data: { name: userName } };
  });
}
