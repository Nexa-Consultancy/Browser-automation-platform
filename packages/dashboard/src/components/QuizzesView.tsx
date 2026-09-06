import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AssessmentGroupRow,
  AssessmentOverview,
  AssessmentPerson,
  OrganizationWithCounts,
  QuizRun,
  StepTemplate,
} from "../types";
import * as api from "../api";
import { relative } from "../format";
import { QuizRunBadge } from "./QuizRunBadge";
import { QuizRunDetail } from "./QuizRunDetail";
import { QuizResultsView } from "./QuizResultsView";
import { TemplatesSettings } from "./TemplatesSettings";

/**
 * The quiz dashboard.
 *
 * Six sections, and none of them re-implements something the platform
 * already has: Groups and Users read the existing organizations/groups/
 * people, Quiz templates IS the existing template screen, and Runs links
 * back into the existing run view. What is genuinely new here is Overview,
 * Runs and Results — the assessment-specific record.
 */
type Tab = "overview" | "groups" | "users" | "templates" | "runs" | "results";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "groups", label: "Groups" },
  { id: "users", label: "Users" },
  { id: "templates", label: "Quiz templates" },
  { id: "runs", label: "Runs" },
  { id: "results", label: "Results" },
];

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  return `${relative(mins)} ago`;
}

export function QuizzesView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        {tab === "overview" && <OverviewSection onOpenRun={setOpenRunId} />}
        {tab === "groups" && <GroupsSection onOpenJob={onOpenJob} />}
        {tab === "users" && <UsersSection />}
        {tab === "templates" && <TemplatesSettings />}
        {tab === "runs" && <RunsSection onOpenRun={setOpenRunId} onOpenJob={onOpenJob} />}
        {tab === "results" && <QuizResultsView onOpenRun={setOpenRunId} />}
      </div>

      {openRunId && <QuizRunDetail runId={openRunId} onClose={() => setOpenRunId(null)} onOpenJob={onOpenJob} />}
    </div>
  );
}

// ---------- Overview ----------

function OverviewSection({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const [data, setData] = useState<{
    overview: AssessmentOverview;
    recentRuns: QuizRun[];
    aiReady: boolean;
    aiMissing: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.assessmentOverview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The same 15s cadence the main dashboard uses, so a run in progress
    // moves here too rather than looking stuck.
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const o = data.overview;

  return (
    <div>
      {/* "Nothing has run" and "nothing CAN run" look identical on a page of
          zeroes, and only one of them is a problem. */}
      {!data.aiReady && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          Quizzes cannot run yet — {data.aiMissing.join("; ")}. Set this up under{" "}
          <strong>Settings → Assessment AI</strong>.
        </div>
      )}

      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-value">{o.organizations}</span>
          <span className="stat-label">organizations</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{o.assessmentGroups}</span>
          <span className="stat-label">assessment groups</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{o.people}</span>
          <span className="stat-label">people</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{o.averageScore === null ? "—" : `${o.averageScore}%`}</span>
          <span className="stat-label">average score</span>
        </div>
      </div>

      <div className="stat-row" style={{ marginTop: 12 }}>
        <div className="stat-card">
          <span className="stat-value">{o.quizzesCompleted}</span>
          <span className="stat-label">quizzes completed</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{o.quizzesPending}</span>
          <span className="stat-label">quizzes pending</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{o.quizzesRunning}</span>
          <span className="stat-label">running now</span>
        </div>
        <div className={`stat-card${o.failedRuns > 0 ? " bad" : ""}`}>
          <span className="stat-value">{o.failedRuns}</span>
          <span className="stat-label">failed · 7d</span>
        </div>
      </div>

      <h3 style={{ marginTop: 28, marginBottom: 12 }}>Recent results</h3>
      {data.recentRuns.length === 0 ? (
        <div className="empty-state">No quizzes have been attempted yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Quiz</th>
                <th>Status</th>
                <th>Score</th>
                <th>Questions</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.recentRuns.map((r) => (
                <tr key={r.id} onClick={() => onOpenRun(r.id)}>
                  <td>{r.personName}</td>
                  <td>{r.quizName}</td>
                  <td>
                    <QuizRunBadge status={r.status} />
                  </td>
                  <td className={r.score === null ? "dim" : "ok"}>{r.score === null ? "—" : `${r.score}%`}</td>
                  <td className="dim">
                    {r.questionsAnswered}
                    {r.questionsTotal > 0 ? ` / ${r.questionsTotal}` : ""}
                  </td>
                  <td className="dim">{fmtWhen(r.completedAt ?? r.startedAt ?? r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Groups ----------

function GroupsSection({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [rows, setRows] = useState<AssessmentGroupRow[]>([]);
  const [templates, setTemplates] = useState<StepTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, t] = await Promise.all([api.assessmentGroups(), api.listTemplates()]);
      setRows(g.groups);
      setTemplates(t.templates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function runNow(groupId: string) {
    setBusy(groupId);
    setError(null);
    try {
      const { jobId } = await api.runAssessmentGroup(groupId);
      onOpenJob(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  const templateName = (id: string | null) => templates.find((t) => t.id === id)?.name ?? null;

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Assessment groups</h2>
          <span className="hint">
            An assessment group is an ordinary group with its type set to Assessment — same roster, days,
            window, timezone and scheduler. Create and edit them on the Groups tab.
          </span>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {loaded && rows.length === 0 && (
        <div className="empty-state">
          No assessment groups yet. Open <strong>Groups</strong>, create or edit a group, and set its type to
          Assessment.
        </div>
      )}

      <div className="group-list">
        {rows.map(({ group, people, ready, blockedBecause }) => (
          <div className={`card group-card${group.activeJobId ? " state-live" : ""}`} key={group.id}>
            <div className="group-card-head">
              <div className="group-title">
                <span className="group-dot" />
                <span className="name">{group.name}</span>
              </div>
              <span className="group-state">{group.activeJobId ? "running" : ready ? "ready" : "not ready"}</span>
            </div>

            <div className="group-window">
              {group.schedule.effectiveStart} → {group.endTime}
              <span className="group-days"> · {group.timezone}</span>
            </div>

            <div className="group-meta">
              <span>
                {people.length} {people.length === 1 ? "person" : "people"}
              </span>
              <span className="target">
                {templateName(group.assessmentTemplateId) ?? "no quiz template"}
              </span>
            </div>

            {/* A group that cannot run says so on the card. Finding that out
                at 2 PM, from an alert, is the alternative. */}
            {!ready && blockedBecause && (
              <div className="editor-status warn" style={{ marginTop: 8 }}>
                {blockedBecause}
              </div>
            )}

            <div className="group-actions">
              {group.activeJobId ? (
                <button className="primary" onClick={() => onOpenJob(group.activeJobId!)}>
                  Watch
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!ready || busy === group.id}
                  title={ready ? "Start this group's assessment now" : (blockedBecause ?? "")}
                  onClick={() => void runNow(group.id)}
                >
                  {busy === group.id ? "Starting…" : "Run now"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Users ----------

function UsersSection() {
  const [people, setPeople] = useState<AssessmentPerson[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationWithCounts[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [p, o] = await Promise.all([api.assessmentPeople(), api.listOrganizations()]);
        setPeople(p.people);
        setOrganizations(o.organizations);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const orgName = (id: string | null) =>
    id ? (organizations.find((o) => o.id === id)?.name ?? "Unassigned") : "Unassigned";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) =>
        p.personName.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        orgName(p.organizationId).toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, query, organizations]);

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>People</h2>
          <span className="hint">
            The same people as everywhere else — this is their assessment state, which is separate from their
            saved browser login.
          </span>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="filter-bar">
        <div className="search-field">
          <span className="search-icon">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, emails or organizations…"
          />
        </div>
      </div>

      {loaded && people.length === 0 && <div className="empty-state">No people yet.</div>}

      {visible.length > 0 && (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Organization</th>
                <th>Completed</th>
                <th>Pending</th>
                <th>Failed</th>
                <th>Average</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.personId} className="no-hover">
                  <td>
                    <span className="run-name">{p.personName}</span>
                    <span className="run-url">{p.email}</span>
                  </td>
                  <td className="dim">{orgName(p.organizationId)}</td>
                  <td className="ok">{p.completedQuizzes}</td>
                  <td className="dim">{p.pendingQuizzes}</td>
                  <td className={p.failedQuizzes > 0 ? "bad" : "dim"}>{p.failedQuizzes}</td>
                  <td>{p.averageScore === null ? <span className="dim">—</span> : `${p.averageScore}%`}</td>
                  <td className="dim">{fmtWhen(p.lastAssessmentRun)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Runs ----------

function RunsSection({
  onOpenRun,
  onOpenJob,
}: {
  onOpenRun: (id: string) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [runs, setRuns] = useState<QuizRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRuns((await api.assessmentRuns()).runs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Quiz runs</h2>
          <span className="hint">One row per attempt at one quiz by one person.</span>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}
      {loaded && runs.length === 0 && <div className="empty-state">No quiz runs yet.</div>}

      {runs.length > 0 && (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Quiz</th>
                <th>Status</th>
                <th>Score</th>
                <th>Questions</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => onOpenRun(r.id)}>
                  <td>{r.personName}</td>
                  <td>
                    <span className="run-name">{r.quizName}</span>
                    {r.error && <span className="run-url">{r.error}</span>}
                  </td>
                  <td>
                    <QuizRunBadge status={r.status} />
                  </td>
                  <td className={r.score === null ? "dim" : "ok"}>{r.score === null ? "—" : `${r.score}%`}</td>
                  <td className="dim">
                    {r.questionsAnswered}
                    {r.questionsTotal > 0 ? ` / ${r.questionsTotal}` : ""}
                  </td>
                  <td className="dim">{fmtWhen(r.startedAt ?? r.createdAt)}</td>
                  <td>
                    {/* A result is never a dead end: the platform run it
                        happened in is one click away, with its events and
                        its screencast. */}
                    {r.jobId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenJob(r.jobId!);
                        }}
                      >
                        Session
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
