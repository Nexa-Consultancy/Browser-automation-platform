/**
 * The bridge between a running session and the quiz engine.
 *
 * Kept out of runner.ts on purpose: everything the engine needs — who this
 * person is, which organization and group, the AI configuration, how to
 * take a screenshot — is assembled here, so the session runner's own loop
 * stays the one thing it already was.
 *
 * Nothing in here launches a browser, opens a context or manages a profile.
 * It is handed the page the ordinary step script has already navigated and
 * logged in, and it hands it to the engine. One Chromium lifecycle.
 */

import type { Page } from "playwright";
import { getGroupUnscoped } from "@automation/db";
import {
  parsePortalConfig,
  readAssessmentAIConfig,
  type Job,
  type SessionEventType,
  type SessionRow,
} from "@automation/shared";
import { runAssessment } from "./engine.js";
import { publishAlert } from "../alert.js";

export interface AssessmentPhaseInput {
  job: Job;
  session: SessionRow;
  /** A getter, not a Page: a portal that opens a quiz in a second tab moves
   * the session there, and activePage.ts is what follows it. Resolving the
   * page per call is what keeps the engine on the tab the session is
   * actually on. */
  page: () => Page;
  settings: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (type: SessionEventType, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Runs the quiz engine for this session, and never throws.
 *
 * A failure here parks the session exactly as a failed step does — the
 * browser stays open, the screencast stays live, and someone can look at
 * what the portal is actually showing. Letting it throw would tear down the
 * session and take that away at precisely the moment it is most useful.
 */
export async function runAssessmentPhase(input: AssessmentPhaseInput): Promise<void> {
  const { job, session } = input;

  // The person is the linked PlatformUser this session is running as. A
  // free-text roster name has no identity to record results against, so an
  // assessment cannot run for one — the API refuses to launch that, and
  // this is the second half of the same rule.
  const personId = session.rowData.userId;
  if (!personId) {
    await input.emit("assessment_failed", {
      error:
        "this session is not running as a linked person, so there is nowhere to record results — " +
        "link real people to the group instead of typing names",
    });
    return;
  }

  const config = parsePortalConfig(job.assessment);
  if (!config.ok) {
    await input.emit("assessment_failed", { error: "the run's portal configuration is invalid" });
    return;
  }

  const ai = readAssessmentAIConfig(input.settings);

  // The group is where the organization comes from, and it is also what
  // ties a quiz result back to the department it belongs to in the Results
  // view. Unscoped, like everything else the worker reads: it holds the id
  // from the job it was given and has no account of its own.
  const group = job.groupId ? await getGroupUnscoped(job.groupId) : null;

  const accountIdForRun = job.groupId ? (group?.accountId ?? null) : null;
  if (!accountIdForRun) {
    await input.emit("assessment_failed", {
      error: "this run has no workspace, so its results could not be filed against one",
    });
    return;
  }

  try {
    await runAssessment({
      page: input.page,
      accountId: accountIdForRun,
      organizationId: group?.organizationId ?? null,
      groupId: job.groupId,
      personId,
      personName: session.userName,
      jobId: job.id,
      sessionId: session.id,
      config: config.config,
      ai,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      emit: input.emit,
      // The platform's existing failure channel: the worker publishes on
      // Redis, the API turns it into an email/Discord/Telegram message and
      // a system_logs row. No second alerting system.
      alert: (message, errorTrace) =>
        publishAlert({
          level: "ERROR",
          source: "worker/assessment",
          message,
          errorTrace: errorTrace ?? null,
          jobId: job.id,
          sessionId: session.id,
          userName: session.userName,
          groupName: group?.name ?? job.name,
        }),
      screenshot: async () => {
        try {
          return await input.page().screenshot({ type: "jpeg", quality: 70 });
        } catch {
          // A screenshot is evidence, not the run. Never let taking one
          // fail the thing it was documenting.
          return null;
        }
      },
    });
  } catch (err) {
    // runAssessment has already emitted assessment_failed and raised the
    // alert; swallowing here is what parks the session instead of killing
    // it, so the live view still shows the page that went wrong.
    const message = err instanceof Error ? err.message : String(err);
    await input.emit("log", { message: `assessment stopped: ${message}` }).catch(() => {});
  }
}
