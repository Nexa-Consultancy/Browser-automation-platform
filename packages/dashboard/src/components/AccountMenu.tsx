import { useEffect, useRef, useState } from "react";
import type { SessionAccount } from "../types";

/**
 * Who you're signed in as, top right. Shows the workspace name rather than
 * just the person's — with each account owning a separate workspace, "which
 * data am I looking at" is the more useful thing to have on screen.
 */
export function AccountMenu({
  account,
  onSignOut,
  onOpenSettings,
}: {
  account: SessionAccount;
  onSignOut: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside and Escape both close it — a dropdown you can only
  // dismiss by hitting the same button again feels stuck.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = account.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className={`account-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Signed in as ${account.name} (${account.email})`}
      >
        <span className="account-avatar" aria-hidden="true">
          {initials || "?"}
        </span>
        <span className="account-trigger-text">
          <span className="account-trigger-workspace">{account.workspaceName || account.name}</span>
          <span className="account-trigger-name">{account.name}</span>
        </span>
        <span className="account-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="account-dropdown" role="menu">
          <div className="account-dropdown-head">
            <strong>{account.name}</strong>
            <span>{account.email}</span>
            {account.role === "admin" && <span className="account-role">admin</span>}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
