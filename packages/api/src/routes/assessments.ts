import type { FastifyInstance } from "fastify";
import {
  assessmentOverview,
  getArtifactData,
  getAssessmentProfile,
  getGroup,
  getQuiz,
  getQuizRun,
  getUser,
  getUsersByIds,
  listArtifacts,
  listAssessmentPeople,
  listGroups,
  listQuestionResults,
  listQuizRuns,
  listQuizzes,
  listQuizzesByPerson,
  getSettings,
  redactSettings,
  setGroupActiveJob,
  updateSettings,
} from "@automation/db";
import {
  aiConfigReadiness,
  buildLinkedUsers,
  isQuizRunStatus,
  readAssessmentAIConfig,
  summarizeQuizzes,
} from "@automation/shared";
import { accountId, requireAuth } from "../auth/context.js";
import { launchJob, stopJob } from "../services/launch.js";
import { planAssessmentRun } from "../services/assessments.js";

/**
 * The Assignments module's REST surface.
 *
 * Read-heavy on purpose. Starting a run goes through the SAME launch path
 * every other run uses (services/launch.ts), and scheduling goes through
 * the existing group scheduler — there is deliberately no second way to
 * start work in this file, because a second way to start work is a second
 * way for the two to disagree about what a run is.
 *
 * Every route is account-scoped through the plugin-level hook below.
 */
export async function assessmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // ---------- overview ----------

  app.get("/api/assessments/overview", async (req) => {
    const account = accountId(req);
    const [overview, settings] = await Promise.all([assessmentOverview(account), getSettings()]);
    const readiness = aiConfigReadiness(readAssessmentAIConfig(settings));
    const recent = await listQuizRuns(account, { limit: 15 });
    // The readiness line is on the overview rather than buried in Settings
    // because "nothing has run" and "nothing CAN run" look identical on a
    // dashboard of zeroes, and only one of them is a problem.
    return { overview, recentRuns: recent, aiReady: readiness.ready, aiMissing: readiness.missing };
  });

  // ---------- groups ----------

  /** The assessment groups, with the roster and readiness the Quizzes tab
   * shows. Reuses the existing groups table — an assessment group IS a
   * group, it is not a copy of one. */
  app.get("/api/assessments/groups", async (req) => {
    const account = accountId(req);
    const groups = (await listGroups(account)).filter((g) => g.groupType === "assessment");
    // Read once and handed down: planAssessmentRun would otherwise fetch the
    // whole settings table per group, which is a query per row for a value
    // that is identical across all of them.
    const settings = await getSettings();
    const rows = await Promise.all(
      groups.map(async (g) => {
        const plan = await planAssessmentRun(g, settings);
        const linked = await getUsersByIds(g.userIds, account);
        return {
          group: g,
          people: linked.map((u) => ({ id: u.id, name: u.name, email: u.email })),
          ready: plan.ok,
          // Shown on the card, so a group that cannot run says so before
          // somebody waits for a window that will abandon its occurrence.
          blockedBecause: plan.ok ? null : plan.error,
        };
      }),
    );
    return { groups: rows };
  });

  // ---------- people ----------

  app.get("/api/assessments/users", async (req) => {
    const { organizationId } = (req.query ?? {}) as { organizationId?: string };
    return { people: await listAssessmentPeople(accountId(req), organizationId || null) };
  });

  /** One person's whole assessment picture: their profile counters, every
   * quiz we know of, and their recent attempts. */
  app.get("/api/assessments/users/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };

    // Scoped through `users` rather than through the assessment tables: a
    // person who has never sat an assessment still has a valid profile page
    // (all zeroes), and 404ing them would be wrong.
    const person = await getUser(id, account);
    if (!person) return reply.code(404).send({ error: "not found" });

    const [quizzes, profile, runs] = await Promise.all([
      listQuizzesByPerson(id, account),
      getAssessmentProfile(id, account),
      listQuizRuns(account, { personId: id, limit: 100 }),
    ]);

    return {
      person: { id: person.id, name: person.name, email: person.email, organizationId: person.organizationId },
      profile,
      // Recomputed from the quiz rows rather than read off the profile: the
      // profile is a cache refreshed at the end of a run, so mid-run it is
      // one run behind, and this page is exactly where that would show.
      summary: summarizeQuizzes(quizzes.map((q) => ({ internalStatus: q.internalStatus, score: q.score }))),
      quizzes,
      runs,
    };
  });

  app.get("/api/assessments/users/:id/history", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    if (!(await getUser(id, account))) return reply.code(404).send({ error: "not found" });
    return { runs: await listQuizRuns(account, { personId: id, limit: 500 }) };
  });

  // ---------- quizzes ----------

  app.get("/api/assessments/quizzes", async (req) => {
    const { organizationId, personId } = (req.query ?? {}) as { organizationId?: string; personId?: string };
    return {
      quizzes: await listQuizzes(accountId(req), {
        organizationId: organizationId || null,
        personId: personId || undefined,
      }),
    };
  });

  app.get("/api/assessments/quizzes/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const quiz = await getQuiz(id, account);
    if (!quiz) return reply.code(404).send({ error: "not found" });
    return { quiz, runs: await listQuizRuns(account, { limit: 100, personId: quiz.personId }) };
  });

  // ---------- runs ----------

  app.get("/api/assessments/runs", async (req) => {
    const { personId, groupId, organizationId, jobId, status } = (req.query ?? {}) as Record<string, string>;
    return {
      runs: await listQuizRuns(accountId(req), {
        personId: personId || undefined,
        groupId: groupId || undefined,
        organizationId: organizationId || undefined,
        jobId: jobId || undefined,
        status: isQuizRunStatus(status) ? status : undefined,
        limit: 300,
      }),
    };
  });

  /** One attempt in full: the structured question log, the artefacts, and
   * the platform run it happened in — so a result is never a dead end. */
  app.get("/api/assessments/runs/:id", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const run = await getQuizRun(id, account);
    if (!run) return reply.code(404).send({ error: "not found" });
    const [questions, artifacts] = await Promise.all([listQuestionResults(id), listArtifacts(id)]);
    return { run, questions, artifacts };
  });

  /**
   * A screenshot's bytes.
   *
   * Its own endpoint rather than a base64 field on the run: the detail view
   * loads for every run, and an inlined JPEG would be paid for on all of
   * them. Scoped through the run that owns it, so knowing an id is not
   * enough to read another workspace's screenshot.
   */
  app.get("/api/assessments/artifacts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await getArtifactData(id, accountId(req));
    if (!artifact) return reply.code(404).send({ error: "not found" });
    reply.header("Content-Type", artifact.contentType);
    // Immutable: an artefact is written once and never changed, so a
    // reload of the results page should not fetch it again.
    reply.header("Cache-Control", "private, max-age=86400, immutable");
    return reply.send(artifact.data);
  });

  // ---------- starting a run ----------

  /**
   * Runs an assessment group now, without waiting for its window.
   *
   * Deliberately the same shape as the Groups tab's "Join now", down to the
   * occurrence rules: a manual run does not consume the day's scheduled
   * one, and the scheduler leaves it alone. Sharing setGroupActiveJob is
   * what enforces "one live run per group" across both entry points.
   */
  app.post("/api/assessments/groups/:id/run", async (req, reply) => {
    const account = accountId(req);
    const { id } = req.params as { id: string };
    const group = await getGroup(id, account);
    if (!group) return reply.code(404).send({ error: "not found" });
    if (group.groupType !== "assessment") {
      return reply.code(400).send({ error: "that group is not an assessment group" });
    }
    if (group.activeJobId) {
      return reply.code(409).send({ error: "this group already has a run in progress" });
    }

    const plan = await planAssessmentRun(group);
    if (!plan.ok) return reply.code(400).send({ error: plan.error });

    // Only linked people can sit an assessment: a free-text userName is a
    // display string with no login and no identity to record results
    // against, so including them would produce runs belonging to nobody.
    const linked = await getUsersByIds(group.userIds, account);
    const users = buildLinkedUsers(linked);
    if (users.length === 0) {
      return reply.code(400).send({
        error: "this group has nobody to run — link at least one signed-in person to it first",
      });
    }

    const { job } = await launchJob({
      name: `${group.name} — assessment`,
      targetUrl: group.targetUrl,
      steps: group.steps,
      users,
      groupId: group.id,
      accountId: account,
      kind: "assessment",
      assessment: plan.plan.assessment,
      concurrencyLimit: plan.plan.browserConcurrency,
    });

    const claimed = await setGroupActiveJob(group.id, job.id);
    if (!claimed) {
      // The scheduler opened the window between the check above and this
      // claim — back the duplicate out rather than leaving two runs live.
      await stopJob(job.id);
      return reply.code(409).send({ error: "this group already has a run in progress" });
    }
    reply.code(201).send({ jobId: job.id });
  });

  // ---------- AI settings ----------

  /**
   * The Assessment AI settings, on their own endpoint.
   *
   * They live in the same `settings` table as the proxy and SMTP config and
   * obey the same rules — whitelisted keys, secrets never sent to the
   * browser, a blank secret meaning "leave it alone". This endpoint is a
   * narrower view of it, so the Assignments settings page does not have to
   * round-trip every unrelated setting to save a threshold.
   */
  app.get("/api/assessment-settings", async () => {
    const settings = await getSettings();
    const redacted = redactSettings(settings);
    const assessment: Record<string, string> = {};
    for (const [k, v] of Object.entries(redacted)) {
      if (k.startsWith("ASSESSMENT_")) assessment[k] = v;
    }
    // Computed from the REAL settings, not the redacted copy — otherwise
    // "__SET__" would read as a present key and readiness would always be
    // true the moment a key was ever saved.
    const readiness = aiConfigReadiness(readAssessmentAIConfig(settings));
    return { settings: assessment, ready: readiness.ready, missing: readiness.missing };
  });

  app.put("/api/assessment-settings", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      // Only this module's keys: a PUT here must not be a back door into
      // the proxy or SMTP config.
      if (!k.startsWith("ASSESSMENT_")) continue;
      // A secret arrives as the "__SET__" marker when the user did not
      // retype it; that means unchanged, not "write the marker".
      patch[k] = v === "__SET__" ? "" : String(v ?? "");
    }
    const saved = await updateSettings(patch);
    const assessment: Record<string, string> = {};
    for (const [k, v] of Object.entries(redactSettings(saved))) {
      if (k.startsWith("ASSESSMENT_")) assessment[k] = v;
    }
    const readiness = aiConfigReadiness(readAssessmentAIConfig(saved));
    reply.send({ settings: assessment, ready: readiness.ready, missing: readiness.missing });
  });
}
