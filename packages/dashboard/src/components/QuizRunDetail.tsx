import { useCallback, useEffect, useRef, useState } from "react";
import type { AssessmentArtifact, QuizQuestionResult, QuizRun } from "../types";
import * as api from "../api";
import { QuizRunBadge } from "./QuizRunBadge";

/**
 * One quiz attempt, in full.
 *
 * The question log is the substance of this screen and it is deliberately
 * structured rather than a wall of screenshots: every question, the options
 * that were on the page, which one was chosen, by which model, how confident
 * it said it was and how long it took. That is what makes a result
 * explainable months later — and searchable, which a screenshot never is.
 *
 * The completion screenshot is here too, as evidence, not as the record.
 */
export function QuizRunDetail({
  runId,
  onClose,
  onOpenJob,
}: {
  runId: string;
  onClose: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const [data, setData] = useState<{
    run: QuizRun;
    questions: QuizQuestionResult[];
    artifacts: AssessmentArtifact[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backdropMouseDown = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api.assessmentRun(runId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A run still going should tick, so watching one is useful rather than
  // needing a refresh to see the next question land.
  useEffect(() => {
    // Poll through every non-terminal state, including submitting/verifying —
    // those are exactly the moments somebody is watching this screen.
    const LIVE = ["queued", "running", "submitting", "verifying"];
    if (!data || !LIVE.includes(data.run.status)) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [data, load]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) onClose();
        backdropMouseDown.current = false;
      }}
    >
      <div className="modal-panel modal-form quiz-run-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{data ? `${data.run.quizName} — ${data.run.personName}` : "Quiz run"}</span>
          <div className="modal-header-actions">
            {data?.run.jobId && (
              <button
                onClick={() => {
                  onOpenJob(data.run.jobId!);
                  onClose();
                }}
              >
                Open session
              </button>
            )}
            <button type="button" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body form-grid">
          {error && <div className="error-banner">{error}</div>}
          {!data && !error && <div className="empty-state">Loading…</div>}

          {data && (
            <>
              <div className="form-section">
                <div className="quiz-run-summary">
                  <div>
                    <span className="stat-label">status</span>
                    <QuizRunBadge status={data.run.status} />
                  </div>
                  <div>
                    <span className="stat-label">score</span>
                    <span className="stat-value small">
                      {data.run.score === null ? (data.run.scoreText ?? "—") : `${data.run.score}%`}
                    </span>
                  </div>
                  <div>
                    <span className="stat-label">questions</span>
                    <span className="stat-value small">
                      {data.run.questionsAnswered}
                      {data.run.questionsTotal > 0 ? ` / ${data.run.questionsTotal}` : ""}
                    </span>
                  </div>
                  <div>
                    <span className="stat-label">started</span>
                    <span className="mono-small">
                      {data.run.startedAt ? new Date(data.run.startedAt).toLocaleString() : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="stat-label">completed</span>
                    <span className="mono-small">
                      {data.run.completedAt ? new Date(data.run.completedAt).toLocaleString() : "—"}
                    </span>
                  </div>
                </div>

                {data.run.error && <div className="error-banner" style={{ marginTop: 12 }}>{data.run.error}</div>}
              </div>

              <div className="form-section">
                <div className="eyebrow">Question log</div>
                {data.questions.length === 0 ? (
                  <div className="empty-state">No questions recorded yet.</div>
                ) : (
                  <div className="question-log">
                    {data.questions.map((q) => (
                      <div className={`question-row${q.error ? " bad" : ""}`} key={q.id}>
                        <div className="question-head">
                          <span className="qnum">Q{q.questionNumber}</span>
                          <span className="qtext">{q.questionText}</span>
                        </div>

                        <div className="qoptions">
                          {q.options.map((o) => (
                            <span
                              key={o.id}
                              className={`qoption${o.id === q.selectedOption ? " chosen" : ""}`}
                              title={o.id === q.selectedOption ? "selected" : undefined}
                            >
                              <b>{o.id}</b> {o.text}
                            </span>
                          ))}
                        </div>

                        <div className="qmeta">
                          {q.error ? (
                            <span className="bad">{q.error}</span>
                          ) : (
                            <>
                              <span className="mono-small">
                                {q.provider}
                                {q.model ? ` · ${q.model}` : ""}
                              </span>
                              {q.confidence !== null && (
                                <span className="mono-small">confidence {q.confidence.toFixed(2)}</span>
                              )}
                              {q.latencyMs !== null && <span className="mono-small">{q.latencyMs}ms</span>}
                              {q.fallbackUsed && <span className="mini-chip on">fallback</span>}
                            </>
                          )}
                        </div>

                        {q.reason && <div className="qreason">{q.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {data.artifacts.length > 0 && (
                <div className="form-section">
                  <div className="eyebrow">Screenshots</div>
                  <div className="artifact-grid">
                    {data.artifacts.map((a) => (
                      <figure className="artifact" key={a.id}>
                        {/* Fetched by URL rather than inlined: the browser
                            caches it, and the run's JSON stays small. */}
                        <img src={api.assessmentArtifactUrl(a.id)} alt={a.caption} loading="lazy" />
                        <figcaption>
                          <span className={`mini-chip${a.kind === "failure" ? "" : " on"}`}>{a.kind}</span>{" "}
                          {a.caption}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
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
