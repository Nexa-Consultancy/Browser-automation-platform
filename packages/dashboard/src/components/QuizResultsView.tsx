import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AssessmentPerson,
  AssessmentProfile,
  AssessmentQuiz,
  GroupWithSchedule,
  OrganizationWithCounts,
  QuizRun,
} from "../types";
import * as api from "../api";
import { relative } from "../format";
import { QuizRunBadge, QuizStatusBadge } from "./QuizRunBadge";

/**
 * Results, read the way the business is shaped.
 *
 *   Organization -> Group -> Person -> their quizzes -> one attempt
 *
 * Which is the existing organizations/groups/people hierarchy, not a new
 * one. Clicking a person opens their assessment profile: the summary, then
 * every quiz with its status and score, then any attempt in full.
 */
const UNASSIGNED = "__unassigned__";

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "never";
  return mins < 1 ? "just now" : `${relative(mins)} ago`;
}

export function QuizResultsView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const [organizations, setOrganizations] = useState<OrganizationWithCounts[]>([]);
  const [groups, setGroups] = useState<GroupWithSchedule[]>([]);
  const [people, setPeople] = useState<AssessmentPerson[]>([]);
  const [openOrg, setOpenOrg] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [o, g, p] = await Promise.all([api.listOrganizations(), api.listGroups(), api.assessmentPeople()]);
        setOrganizations(o.organizations);
        setGroups(g.groups);
        setPeople(p.people);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /** Organization rows, plus an "Unassigned" one when anything still sits
   * outside an organization — hiding those would hide real people. */
  const orgRows = useMemo(() => {
    const rows = organizations.map((o) => ({ id: o.id, name: o.name }));
    if (people.some((p) => !p.organizationId)) rows.push({ id: UNASSIGNED, name: "Unassigned" });
    return rows;
  }, [organizations, people]);

  const peopleOf = useCallback(
    (orgId: string) => people.filter((p) => (p.organizationId ?? UNASSIGNED) === orgId),
    [people],
  );

  const groupsOf = useCallback(
    (orgId: string) =>
      groups.filter((g) => (g.organizationId ?? UNASSIGNED) === orgId && g.groupType === "assessment"),
    [groups],
  );

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Results</h2>
          <span className="hint">Organization → group → person → quiz. Click a person for their full history.</span>
        </div>
      </div>

      {loaded && orgRows.length === 0 && <div className="empty-state">Nothing to show yet.</div>}

      <div className="group-list">
        {orgRows.map((org) => {
          const orgPeople = peopleOf(org.id);
          const orgGroups = groupsOf(org.id);
          const completed = orgPeople.reduce((n, p) => n + p.completedQuizzes, 0);
          const pending = orgPeople.reduce((n, p) => n + p.pendingQuizzes, 0);
          const isOpen = openOrg === org.id;

          return (
            <div className="card" key={org.id}>
              <button
                type="button"
                className="detail-toggle"
                onClick={() => setOpenOrg(isOpen ? null : org.id)}
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                <span>
                  <span className="chev">{isOpen ? "▾" : "▸"}</span> <strong>{org.name}</strong>
                </span>
                <span className="mono-small">
                  {orgPeople.length} {orgPeople.length === 1 ? "person" : "people"} · {completed} completed ·{" "}
                  {pending} pending
                </span>
              </button>

              {isOpen && (
                <div style={{ marginTop: 14 }}>
                  {orgGroups.length > 0 && (
                    <div className="group-meta" style={{ marginBottom: 10 }}>
                      <span className="hint">
                        assessment groups: {orgGroups.map((g) => g.name).join(", ")}
                      </span>
                    </div>
                  )}

                  {orgPeople.length === 0 ? (
                    <div className="empty-state">Nobody in this organization yet.</div>
                  ) : (
                    <div className="table-scroll">
                      <table className="history-table">
                        <thead>
                          <tr>
                            <th>Person</th>
                            <th>Completed</th>
                            <th>Pending</th>
                            <th>Failed</th>
                            <th>Average</th>
                            <th>Last run</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orgPeople.map((p) => (
                            <tr key={p.personId} onClick={() => setOpenPerson(p.personId)}>
                              <td>
                                <span className="run-name">{p.personName}</span>
                                <span className="run-url">{p.email}</span>
                              </td>
                              <td className="ok">{p.completedQuizzes}</td>
                              <td className="dim">{p.pendingQuizzes}</td>
                              <td className={p.failedQuizzes > 0 ? "bad" : "dim"}>{p.failedQuizzes}</td>
                              <td>
                                {p.averageScore === null ? <span className="dim">—</span> : `${p.averageScore}%`}
                              </td>
                              <td className="dim">{fmtAgo(p.lastAssessmentRun)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {openPerson && (
        <PersonProfileModal personId={openPerson} onClose={() => setOpenPerson(null)} onOpenRun={onOpenRun} />
      )}
    </div>
  );
}

/**
 * One person's assessment profile.
 *
 * The thing that survives runs: what they have completed, what is left, what
 * failed, and every attempt. This is what the next run reads before it does
 * anything, so it is worth being able to look at directly.
 */
function PersonProfileModal({
  personId,
  onClose,
  onOpenRun,
}: {
  personId: string;
  onClose: () => void;
  onOpenRun: (id: string) => void;
}) {
  const [data, setData] = useState<{
    person: { id: string; name: string; email: string; organizationId: string | null };
    profile: AssessmentProfile | null;
    summary: {
      totalQuizzes: number;
      completedQuizzes: number;
      pendingQuizzes: number;
      failedQuizzes: number;
      averageScore: number | null;
    };
    quizzes: AssessmentQuiz[];
    runs: QuizRun[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await api.assessmentPerson(personId));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [personId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The attempts for one quiz, newest first — so a quiz that was retried
   * after a failure shows both, rather than only the last word. */
  const runsFor = (quizId: string) => (data?.runs ?? []).filter((r) => r.quizId === quizId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel modal-form quiz-run-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{data ? `${data.person.name} — assessment profile` : "Assessment profile"}</span>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body form-grid">
          {error && <div className="error-banner">{error}</div>}
          {!data && !error && <div className="empty-state">Loading…</div>}

          {data && (
            <>
              <div className="form-section">
                <div className="stat-row">
                  <div className="stat-card">
                    <span className="stat-value">{data.summary.totalQuizzes}</span>
                    <span className="stat-label">total quizzes</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-value">{data.summary.completedQuizzes}</span>
                    <span className="stat-label">completed</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-value">{data.summary.pendingQuizzes}</span>
                    <span className="stat-label">pending</span>
                  </div>
                  <div className={`stat-card${data.summary.failedQuizzes > 0 ? " bad" : ""}`}>
                    <span className="stat-value">{data.summary.failedQuizzes}</span>
                    <span className="stat-label">failed</span>
                  </div>
                </div>
                <div className="group-meta" style={{ marginTop: 12 }}>
                  <span>
                    average{" "}
                    {data.summary.averageScore === null ? "—" : `${data.summary.averageScore}%`}
                  </span>
                  <span className="hint">last run {fmtAgo(data.profile?.lastAssessmentRun ?? null)}</span>
                  <span className="hint">
                    last successful {fmtAgo(data.profile?.lastSuccessfulRun ?? null)}
                  </span>
                </div>
              </div>

              <div className="form-section">
                <div className="eyebrow">Quiz history</div>
                {data.quizzes.length === 0 ? (
                  <div className="empty-state">No quizzes discovered for this person yet.</div>
                ) : (
                  <div className="table-scroll">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th>Quiz</th>
                          <th>Status</th>
                          <th>Portal says</th>
                          <th>Score</th>
                          <th>Completed</th>
                          <th>Attempts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.quizzes.map((q) => {
                          const attempts = runsFor(q.id);
                          return (
                            <tr key={q.id} className="no-hover">
                              <td>
                                <span className="run-name">{q.quizName}</span>
                                <span className="run-url">{q.externalQuizId}</span>
                              </td>
                              <td>
                                <QuizStatusBadge status={q.internalStatus} />
                              </td>
                              {/* Shown next to ours because the portal is the
                                  authority: when they disagree, the portal
                                  wins and our row is corrected. */}
                              <td className="dim">{q.portalStatus.replace(/_/g, " ")}</td>
                              <td className={q.score === null ? "dim" : "ok"}>
                                {q.score === null ? (q.scoreText ?? "—") : `${q.score}%`}
                              </td>
                              <td className="dim">
                                {q.completedAt ? new Date(q.completedAt).toLocaleDateString() : "—"}
                              </td>
                              <td>
                                {attempts.length === 0 ? (
                                  <span className="dim">—</span>
                                ) : (
                                  <div className="attempt-links">
                                    {attempts.map((r) => (
                                      <button
                                        key={r.id}
                                        className="attempt-link"
                                        onClick={() => {
                                          onOpenRun(r.id);
                                          onClose();
                                        }}
                                      >
                                        <QuizRunBadge status={r.status} />
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
