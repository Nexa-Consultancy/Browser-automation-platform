import { useEffect, useState } from "react";
import { QuizzesView } from "./QuizzesView";

/**
 * The Assignments module.
 *
 * Two subsections, and only one of them exists yet. That is stated plainly
 * rather than hidden: a tab that silently isn't there reads as a bug, and a
 * tab that says what it is waiting for reads as a plan.
 */
type Section = "quizzes" | "assignments";

function sectionFromHash(): Section {
  return location.hash.startsWith("#/assignments/assignments") ? "assignments" : "quizzes";
}

export function AssignmentsView({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [section, setSection] = useState<Section>(sectionFromHash());

  // The subsection lives in the hash so a link to a specific one works and
  // Back behaves, same as every other route in the app.
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(next: Section) {
    location.hash = next === "quizzes" ? "#/assignments" : "#/assignments/assignments";
    setSection(next);
  }

  return (
    <div>
      <div className="job-toolbar">
        <div className="job-toolbar-title">
          <h2>Assignments</h2>
          <span className="hint">AI-assisted assessments, run by the same groups and the same schedule.</span>
        </div>
      </div>

      <div className="type-filter" style={{ marginBottom: 20 }}>
        <button type="button" className={section === "quizzes" ? "active" : ""} onClick={() => go("quizzes")}>
          Quizzes
        </button>
        <button
          type="button"
          className={section === "assignments" ? "active" : ""}
          onClick={() => go("assignments")}
        >
          Assignments
        </button>
      </div>

      {section === "quizzes" ? <QuizzesView onOpenJob={onOpenJob} /> : <AssignmentsPlaceholder />}
    </div>
  );
}

/**
 * Phase 2.
 *
 * Deliberately says what already exists underneath it rather than just
 * "coming soon" — the database, the queue, the worker routing and the
 * results model are shared with quizzes, so this is a runner and a UI, not
 * a second system.
 */
function AssignmentsPlaceholder() {
  return (
    <div className="card">
      <div className="eyebrow">Phase 2</div>
      <p style={{ marginTop: 0 }}>Assignment automation is planned for a future phase.</p>
      <p className="hint" style={{ marginTop: 12 }}>
        The groundwork is already shared with Quizzes: the same organizations, groups and people, the same
        BullMQ queue and isolated browser sessions, the same run history, structured event log and artefact
        storage. What is still to come is assignment discovery, reading an assignment&rsquo;s content,
        AI-assisted drafting of a response, and the submission workflow — none of which is built yet, and none
        of which needs the architecture to change.
      </p>
    </div>
  );
}
