import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupWithSchedule } from "../types";
import * as api from "../api";

const TASK_PLACEHOLDER = `fill Email with {{name}}@example.com
click Join
wait for text "Live"
wait for video`;

const MAX_USERS = 200;

// Common head-starts. "On time" is kept as an explicit choice rather than an
// empty field so the default is a decision, not an oversight.
const LEAD_CHOICES = [0, 5, 10, 15, 30];

// Monday-first for display; the values are 0 = Sunday ... 6 = Saturday,
// which is what the server stores and what Date#getDay returns.
const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/** Grows/shrinks the name roster in place so names already typed survive a
 * change to the user count (both directions). */
function resizeNames(names: string[], count: number): string[] {
  return Array.from({ length: count }, (_, i) => names[i] ?? "");
}

/** Shift an "HH:MM" by N minutes, wrapping over midnight. */
function shiftHhMm(hhmm: string, deltaMinutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const total = (((h * 60 + m + deltaMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "17:00" -> "5:00 PM", for the plain-language echo under the time fields. */
function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Create *and* edit — one form, so the two can never drift apart in what
 * they offer. Passing `group` prefills every field from the saved group and
 * switches the save to an update, which is what makes a group stay exactly
 * as configured until someone deliberately changes it.
 */
export function GroupModal({
  serverTimezone,
  group,
  onClose,
  onSaved,
}: {
  serverTimezone: string;
  group?: GroupWithSchedule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!group;
  // The stored steps always begin with the auto-injected "open {{url}}";
  // don't show that back to the user as if they had typed it.
  const initialSteps = group
    ? group.steps.filter((s, i) => !(i === 0 && /^(open|go to|navigate to)\s+\{\{?url\}?\}$/i.test(s))).join("\n")
    : "";

  const [name, setName] = useState(group?.name ?? "");
  const [targetUrl, setTargetUrl] = useState(group?.targetUrl ?? "");
  const [steps, setSteps] = useState(initialSteps);
  const [userCount, setUserCount] = useState(group?.userNames.length ?? 2);
  const [names, setNames] = useState<string[]>(group?.userNames ?? ["", ""]);
  const [startTime, setStartTime] = useState(group?.startTime ?? "17:00");
  const [endTime, setEndTime] = useState(group?.endTime ?? "21:00");
  const [days, setDays] = useState<number[]>(group?.days ?? [1, 2, 3, 4, 5]);
  const [leadMinutes, setLeadMinutes] = useState(group?.leadMinutes ?? 5);
  const [autoFollow, setAutoFollow] = useState(group?.enabled ?? true);
  // On create you have to write the prompt, so it starts open. On an
  // existing group it stays hidden until deliberately revealed — the prompt
  // is the private part of a group and shouldn't sit on screen by default.
  const [showPrompt, setShowPrompt] = useState(!group);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by any edit in the form. Once true, nothing closes this dialog
  // without asking — losing a half-filled group to a stray key or click is
  // far worse than one extra confirm.
  const [dirty, setDirty] = useState(false);
  const backdropMouseDown = useRef(false);

  const requestClose = useCallback(() => {
    if (dirty && !confirm("Discard this group? Anything you have typed will be lost.")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape also dismisses a native date/time picker and a <select>
      // dropdown. Closing the whole dialog because someone dismissed a
      // picker is how a filled-in form disappears, so a keypress landing on
      // a field is left to the field.
      const el = document.activeElement;
      const inField =
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement;
      if (inField) return;
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  function changeUserCount(raw: number) {
    const count = Math.max(1, Math.min(MAX_USERS, Math.floor(raw) || 1));
    setUserCount(count);
    setNames((prev) => resizeNames(prev, count));
  }

  function changeName(index: number, value: string) {
    setNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  }

  function toggleDay(value: number) {
    setDays((prev) => (prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value]));
  }

  const crossesMidnight = endTime < startTime;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const filled = names.map((n) => n.trim());
    if (filled.some((n) => !n)) {
      setError(`Enter a name for all ${userCount} user(s) — every user in the group needs one.`);
      return;
    }
    if (days.length === 0) {
      setError("Pick at least one day for this group to run on.");
      return;
    }
    if (startTime === endTime) {
      setError("Start time and end time must differ.");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name,
        targetUrl,
        steps,
        userNames: filled,
        startTime,
        endTime,
        leadMinutes,
        days,
        timezone: group?.timezone ?? serverTimezone,
        enabled: autoFollow,
      };
      if (group) await api.updateGroup(group.id, payload);
      else await api.createGroup(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      // A click is only a backdrop click when it BEGINS and ENDS on the
      // backdrop. Without the mousedown half, drag-selecting text in the
      // prompt box and releasing outside the panel dispatches the click on
      // the nearest common ancestor — the backdrop — and throws the whole
      // half-filled form away.
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div className="modal-panel modal-form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{editing ? `Edit ${group!.name}` : "Create new group"}</span>
          <button type="button" onClick={requestClose}>
            ✕
          </button>
        </div>

        <form
          className="form-grid"
          onSubmit={submit}
          onChange={() => setDirty(true)}
          // Enter in a single-line field would otherwise submit the form
          // implicitly — saving a group someone was still filling in, or
          // failing validation and looking like the dialog "did something".
          // Saving stays an explicit press of the Save button. The prompt is
          // a textarea, so its Enter still makes a new line.
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.target as HTMLElement)?.tagName === "INPUT") {
              e.preventDefault();
            }
          }}
        >
          {error && <div className="error-banner">{error}</div>}

          <div className="form-section">
            <div className="eyebrow">Target</div>
            <div className="form-two-col">
              <div className="form-row">
                <label>Group name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Evening webinar crew"
                />
              </div>
              <div className="form-row">
                <label>Link</label>
                <input
                  type="url"
                  required
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://app.example.com/room/42"
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="eyebrow">Users</div>
            <div className="form-row" style={{ maxWidth: 200 }}>
              <label>Number of users</label>
              <input
                type="number"
                min={1}
                max={MAX_USERS}
                value={userCount}
                onChange={(e) => changeUserCount(Number(e.target.value))}
              />
            </div>
            <div className="name-grid">
              {names.map((n, i) => (
                <div className="form-row" key={i}>
                  <label>User {i + 1}</label>
                  <input
                    type="text"
                    value={n}
                    onChange={(e) => changeName(i, e.target.value)}
                    placeholder={`e.g. ${["Asha", "Ravi", "Meera", "Dev", "Nila"][i % 5]}`}
                  />
                </div>
              ))}
            </div>
            <div className="hint">
              One browser session per user, fully isolated. Each name is available in the task as {"{{name}}"}.
            </div>
          </div>

          <div className="form-section">
            <div className="eyebrow">Task</div>
            {editing && (
              <button type="button" className="reveal-btn" onClick={() => setShowPrompt((v) => !v)}>
                <span className="eye">{showPrompt ? "🙈" : "👁"}</span>
                {showPrompt ? "Hide prompt" : "View prompt"}
              </button>
            )}
            <div className="form-row" hidden={!showPrompt}>
              <label>What this group should do (one step per line)</label>
              <textarea
                required
                rows={6}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder={TASK_PLACEHOLDER}
              />
              <div className="hint">
                The link above is opened automatically as step 1. Supported: click X · fill X with Y · type X ·
                select X in Y · check/uncheck X · press KEY · wait for text "X" · wait N seconds · wait for video ·
                wait for element "selector" · screenshot
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="eyebrow">Schedule</div>

            <div className="form-row">
              <label>Days</label>
              <div className="day-picker">
                {DAYS.map((d) => (
                  <label className={`day-chip${days.includes(d.value) ? " on" : ""}`} key={d.value}>
                    <input type="checkbox" checked={days.includes(d.value)} onChange={() => toggleDay(d.value)} />
                    {d.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="form-three-col" style={{ marginTop: 14 }}>
              <div className="form-row">
                <label>Event time</label>
                <input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                <div className="hint">When the thing you're automating actually happens.</div>
              </div>
              <div className="form-row">
                <label>Start early by</label>
                <select value={leadMinutes} onChange={(e) => setLeadMinutes(Number(e.target.value))}>
                  {LEAD_CHOICES.map((m) => (
                    <option value={m} key={m}>
                      {m === 0 ? "On time" : `${m} minutes before`}
                    </option>
                  ))}
                </select>
                <div className="hint">Browsers open early so they're logged in before it starts.</div>
              </div>
              <div className="form-row">
                <label>End</label>
                <input type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
            <div className="hint">
              Begins at <strong>{to12Hour(shiftHhMm(startTime, -leadMinutes))}</strong>
              {leadMinutes > 0 && <> — {leadMinutes} min before the {to12Hour(startTime)} event</>} and stops at{" "}
              <strong>{to12Hour(endTime)}</strong>
              {crossesMidnight ? " the next morning" : ""}, on each selected day.
              <br />
              All times are <strong>{serverTimezone}</strong>.
            </div>

            <label className="switch-row">
              <input type="checkbox" checked={autoFollow} onChange={(e) => setAutoFollow(e.target.checked)} />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-knob" />
              </span>
              <span className="switch-text">
                <strong>Follow this schedule automatically</strong>
                <span className="hint">
                  {autoFollow
                    ? "The server starts and stops this group on its own — nobody needs the dashboard open. If it's already inside its window when you save, it starts within a few seconds."
                    : "Held off by hand — this group runs only when you press Join now."}
                </span>
              </span>
            </label>
          </div>

          <div className="form-section modal-actions">
            <button type="button" onClick={requestClose} disabled={submitting}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
