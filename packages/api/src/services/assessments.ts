/**
 * Turning an assessment group into a launchable run.
 *
 * One function, used by BOTH the scheduler and "Join now", for the same
 * reason launchJob is shared: a scheduled assessment and a hand-started one
 * must be the same kind of run, or the thing that works when you test it is
 * not the thing that fires at 2 PM.
 *
 * It also front-loads every reason an assessment cannot run — no template,
 * no selectors, no AI key — so those are answered at the button, with a
 * list of what to fill in, rather than as a timeout inside a browser twenty
 * minutes later.
 */

import { getSettings, getTemplate } from "@automation/db";
import {
  TS_TEMPLATE_NOT_EXECUTABLE,
  aiConfigReadiness,
  parsePortalConfig,
  portalConfigReadiness,
  readAssessmentAIConfig,
  readAssessmentBrowserConcurrency,
  type AssessmentPortalConfig,
  type Group,
} from "@automation/shared";

export interface AssessmentPlan {
  assessment: AssessmentPortalConfig;
  /** How many of this group's people may have a browser open at once. */
  browserConcurrency: number;
}

export type AssessmentPlanResult = { ok: true; plan: AssessmentPlan } | { ok: false; error: string };

/**
 * Everything an assessment run needs, or the sentence explaining why it
 * cannot start.
 *
 * Deliberately strict: an assessment that starts without a configured
 * portal does not fail cleanly, it logs somebody into a real system and
 * then flails at a page it cannot read. Refusing up front is the kinder
 * failure by a wide margin.
 */
export async function planAssessmentRun(
  group: Group,
  /** Passed in by callers that already loaded it (the groups list resolves
   * several groups in one request), so settings are read once per request
   * rather than once per group. */
  preloadedSettings?: Record<string, string>,
): Promise<AssessmentPlanResult> {
  if (!group.assessmentTemplateId) {
    return {
      ok: false,
      error: "this assessment group has no quiz template — pick one in the group's settings first",
    };
  }

  // A group with no workspace cannot file results against one, and cannot
  // have its template ownership checked either. phase.ts refuses the same
  // case in the worker; refusing it here means it never gets that far.
  if (!group.accountId) {
    return { ok: false, error: "this group has no workspace, so its assessment results could not be filed" };
  }

  // SCOPED to the group's own workspace. This lookup used to be unscoped,
  // with a comment claiming the ownership was "checked below" — it was not.
  // A group could name another account's template id and quietly read (and
  // run) that workspace's portal configuration. The group already carries
  // the account the template must belong to, so the scoped read is both the
  // correct lookup and the check.
  const template = await getTemplate(group.assessmentTemplateId, group.accountId);
  if (!template) {
    return { ok: false, error: "this group's quiz template no longer exists" };
  }
  if (template.templateType === "typescript") {
    return { ok: false, error: TS_TEMPLATE_NOT_EXECUTABLE };
  }

  const parsed = parsePortalConfig(template.assessment);
  if (!parsed.ok) {
    return { ok: false, error: `the quiz template's portal config is invalid` };
  }

  const readiness = portalConfigReadiness(parsed.config);
  if (!readiness.ready) {
    return {
      ok: false,
      error:
        `the quiz template "${template.name}" is missing the selectors the engine needs: ` +
        `${readiness.missing.join(", ")}. Fill them in under Assignments → Quiz templates.`,
    };
  }

  const settings = preloadedSettings ?? (await getSettings());
  const ai = aiConfigReadiness(readAssessmentAIConfig(settings));
  if (!ai.ready) {
    return { ok: false, error: `assessment AI is not ready: ${ai.missing.join("; ")}` };
  }

  return {
    ok: true,
    plan: {
      assessment: parsed.config,
      browserConcurrency: readAssessmentBrowserConcurrency(settings),
    },
  };
}
