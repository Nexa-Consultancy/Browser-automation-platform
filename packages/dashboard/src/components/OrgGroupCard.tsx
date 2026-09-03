import { useState } from "react";
import type { GroupWithSchedule, PlatformUser } from "../types";
import * as api from "../api";
import { describeDays, relative, to12Hour } from "../format";
import { UserStatusChip } from "./UserStatusChip";

/**
 * One department, as a card. The four things the card has to answer at a
 * glance — without opening anything — are the group's name, who is in it,
 * the link it opens, and when it runs; everything else is behind the
 * expand. Clicking the card expands it in place rather than opening a
 * dialog, so you can keep the rest of the organization in view while you
 * work on one department.
 */
export function OrgGroupCard({
  group,
  organizationName,
  candidates,
  expanded,
  onToggle,
  onEdit,
  onAddPerson,
  onChanged,
  onOpenJob,
  onError,
}: {
  group: GroupWithSchedule;
  organizationName: string;
  /** Users in this organization who are not in this group yet. */
  candidates: PlatformUser[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAddPerson: () => void;
  onChanged: () => void | Promise<void>;
  onOpenJob: (jobId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const live = !!group.activeJobId;
  const spent =
    group.schedule.occurrenceKey !== null && group.lastOccurrenceKey === group.schedule.occurrenceKey;
  const pending = group.enabled && group.schedule.inWindow && !spent;
  const state = live ? (group.activeRunIsManual ? "manual" : "live") : !group.enabled ? "held" : pending ? "starting" : "idle";

  const headcount = group.userNames.length + group.linkedUsers.length;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`org-group-card state-${state}${expanded ? " expanded" : ""}`}>
      {/* The whole head is the expander, so the target is the card rather
          than a chevron someone has to aim at. */}
      <button type="button" className="org-group-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="org-group-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="org-group-identity">
          <span className="org-group-name">{group.name}</span>
          <span className="org-group-state">{state}</span>
        </span>
        <span className="org-group-when">
          <span className="org-group-time">
            {to12Hour(group.schedule.effectiveStart)} → {to12Hour(group.endTime)}
          </span>
          <span className="org-group-days">{describeDays(group.days)}</span>
        </span>
      </button>

      <div className="org-group-facts">
        <div className="org-fact">
          <span className="org-fact-label">People</span>
          <span className="org-fact-value">
            {headcount === 0 ? (
              <span className="org-muted">nobody yet</span>
            ) : (
              <span className="org-people-chips">
                {group.linkedUsers.map((u) => (
                  <UserStatusChip signedIn={u.signedIn} name={u.name} showLabel={false} key={u.id} />
                ))}
                {group.userNames.map((n, i) => (
                  <span className="org-person-chip guest" key={`${n}-${i}`} title="Typed guest name — no login of their own">
                    {n}
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>

        <div className="org-fact">
          <span className="org-fact-label">Link</span>
          <a
            className="org-fact-value org-link"
            href={group.targetUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={group.targetUrl}
          >
            {group.targetUrl}
          </a>
        </div>

        <div className="org-fact">
          <span className="org-fact-label">Timing</span>
          <span className="org-fact-value">
            {to12Hour(group.schedule.effectiveStart)} → {to12Hour(group.endTime)} · {describeDays(group.days)}{" "}
            <span className="org-muted">{group.timezone}</span>
            {group.leadMinutes > 0 && (
              <span className="org-lead" title={`Opens ${group.leadMinutes} min before the ${to12Hour(group.startTime)} event`}>
                {group.leadMinutes}m early
              </span>
            )}
          </span>
        </div>

        <div className="org-fact">
          <span className="org-fact-label">Status</span>
          <span className="org-fact-value org-muted">
            {live && group.activeRunIsManual
              ? "Running now, started by hand"
              : live
                ? `Running now · stops in ${relative(group.schedule.minutesUntilEnd)}`
                : !group.enabled
                  ? "Held off the schedule — runs only when someone starts it"
                  : pending
                    ? "Inside its window — starting within a few seconds"
                    : spent
                      ? `Already ran today · next start in ${relative(group.schedule.minutesUntilStart)}`
                      : `Next start in ${relative(group.schedule.minutesUntilStart)}`}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="org-group-body">
          <div className="org-roster">
            <div className="org-roster-head">
              <span className="eyebrow">People in {group.name}</span>
              <button type="button" onClick={onAddPerson}>
                + Add a person
              </button>
            </div>

            {group.linkedUsers.length === 0 && group.userNames.length === 0 && (
              <div className="org-empty-inline">
                Nobody in {group.name} yet — add a person, or bring one across from {organizationName}.
              </div>
            )}

            {group.linkedUsers.map((u) => (
              <div className="org-roster-row" key={u.id}>
                <UserStatusChip signedIn={u.signedIn} name={u.name} />
                <button
                  type="button"
                  disabled={busy}
                  title={`Take ${u.name} out of ${group.name}. They keep their login and stay in any other group.`}
                  onClick={() => void act(() => api.removeUserFromGroup(group.id, u.id))}
                >
                  Remove
                </button>
              </div>
            ))}

            {group.userNames.map((n, i) => (
              <div className="org-roster-row" key={`${n}-${i}`}>
                <span className="org-person-chip guest">{n}</span>
                <span className="org-muted">typed guest name — edit the group to change</span>
              </div>
            ))}

            {candidates.length > 0 && (
              <div className="org-roster-add">
                <label htmlFor={`add-existing-${group.id}`}>Bring someone across</label>
                <select
                  id={`add-existing-${group.id}`}
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    const userId = e.target.value;
                    if (userId) void act(() => api.addUserToGroup(group.id, userId));
                  }}
                >
                  <option value="">Someone already in {organizationName}…</option>
                  {candidates.map((u) => (
                    <option value={u.id} key={u.id}>
                      {u.name} — {u.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="org-group-actions">
            {group.activeJobId && (
              <button type="button" onClick={() => onOpenJob(group.activeJobId!)}>
                Watch live
              </button>
            )}
            {live ? (
              <button type="button" className="danger" disabled={busy} onClick={() => void act(() => api.stopGroupNow(group.id))}>
                ■ Stop now
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const { jobId } = await api.runGroupNow(group.id);
                    onOpenJob(jobId);
                  })
                }
              >
                ▶ Start now
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              title="Follow this schedule automatically"
              onClick={() => void act(() => api.setGroupEnabled(group.id, !group.enabled))}
            >
              {group.enabled ? "Hold off schedule" : "Follow schedule"}
            </button>
            <button type="button" disabled={busy} onClick={onEdit}>
              Edit group
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete "${group.name}"? Any run it has open will be stopped. The people in it are not deleted.`)) {
                  void act(() => api.deleteGroup(group.id));
                }
              }}
            >
              Delete group
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
