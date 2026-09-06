/**
 * How a template is written.
 *
 * The platform started with exactly one format — the plain-English step
 * script — and that stays the default in every sense: an existing template
 * with no type is "plain", and nothing about how it parses or runs changes.
 * The other two are additive formats that reduce to the SAME normalized
 * workflow the plain script does (see compileTemplate below), so there is
 * one executor, not three.
 *
 *   plain      -> parseStep() per line          (unchanged, the original)
 *   json       -> validateJsonWorkflow() -> ParsedStep[]
 *   typescript -> stored + validated; execution is a documented future seam
 */
export type TemplateType = "plain" | "json" | "typescript";

export const TEMPLATE_TYPES: TemplateType[] = ["plain", "json", "typescript"];

/** What each one is called in the UI. Kept here so the dashboard filter,
 * the editor heading and any error message all say the same word. */
export const TEMPLATE_TYPE_LABELS: Record<TemplateType, string> = {
  plain: "Plain-English",
  json: "JSON",
  typescript: "TypeScript",
};

export function isTemplateType(value: unknown): value is TemplateType {
  return value === "plain" || value === "json" || value === "typescript";
}

/**
 * Reads a stored/posted type, defaulting to "plain".
 *
 * Every template that existed before types did is plain-English, and a
 * client that doesn't know about types yet sends nothing — both have to
 * keep working, so an unknown value is not an error here, it's the default.
 */
export function templateTypeOf(value: unknown): TemplateType {
  return isTemplateType(value) ? value : "plain";
}

/** The list filter's value: a specific type, or everything. */
export type TemplateTypeFilter = TemplateType | "all";

export function isTemplateTypeFilter(value: unknown): value is TemplateTypeFilter {
  return value === "all" || isTemplateType(value);
}

/**
 * The one definition of "does this template belong in this list", shared by
 * the API's ?type= query and the dashboard's filter buttons so the two can
 * never disagree about what "JSON" shows.
 */
export function templateMatchesFilter(
  template: { templateType: TemplateType },
  filter: TemplateTypeFilter,
): boolean {
  return filter === "all" || template.templateType === filter;
}
