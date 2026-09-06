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

import { getSettings, getTemplateUnscoped } from "@automation/db";
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
export async function planAssessmentRun(group: Group): Promise<AssessmentPlanResult> {
  if (!group.assessmentTemplateId) {
    return {
      ok: false,
      error: "this assessment group has no quiz template — pick one in the group's settings first",
    };
  }

  // Unscoped: the scheduler has no account of its own, and the group
  // already names the workspace the template must belong to (checked below).
  const template = await getTemplateUnscoped(group.assessmentTemplateId);
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

  const settings = await getSettings();
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
