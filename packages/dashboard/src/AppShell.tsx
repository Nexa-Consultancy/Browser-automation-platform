import { useEffect, useState } from "react";
import type { SessionAccount } from "./types";
import { JobForm } from "./components/JobForm";
import { JobList } from "./components/JobList";
import { JobView } from "./components/JobView";
import { GroupList } from "./components/GroupList";
import { PeoplePanel } from "./components/PeoplePanel";
import { DashboardView } from "./components/DashboardView";
import { OrganizationsView } from "./components/OrganizationsView";
import { SettingsView } from "./components/SettingsView";
import { EgressBadge } from "./components/EgressBadge";
import { AccountMenu } from "./components/AccountMenu";

type Route =
  | { view: "runs" }
  | { view: "groups" }
  | { view: "organizations" }
  | { view: "dashboard" }
  | { view: "settings" }
  | { view: "job"; jobId: string };

// Dashboard is the landing view: it's the one place that shows what's live
// right now, what's coming up on the schedule, and the history underneath
// — the first thing anyone should see, not a group's config form.
function routeFromHash(): Route {
  const job = location.hash.match(/^#\/job\/(.+)$/);
  if (job) return { view: "job", jobId: job[1] };
  if (location.hash === "#/runs") return { view: "runs" };
  if (location.hash === "#/groups") return { view: "groups" };
  if (location.hash === "#/organizations") return { view: "organizations" };
  if (location.hash === "#/settings") return { view: "settings" };
  return { view: "dashboard" };
}

/**
 * The signed-in application. Everything here assumes an account, which is
 * why it is a separate component from App: the guard happens once, above,
 * rather than being re-checked by every view.
 */
export function AppShell({
  account,
  onSignOut,
  onSessionLost,
}: {
  account: SessionAccount;
  onSignOut: () => void;
  onSessionLost: () => void;
}) {
  const [route, setRoute] = useState<Route>(routeFromHash());

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /**
   * A session can end while the tab is open — it was signed out elsewhere,
   * or an admin suspended the account. Every view would then start failing
   * with 401s and showing error banners it can't explain. Watching for one
   * centrally turns that into a clean return to the login page.
   */
  useEffect(() => {
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
      if (res.status === 401 && url.includes("/api/")) onSessionLost();
      return res;
    };
    return () => {
      window.fetch = origFetch;
    };
  }, [onSessionLost]);

  function go(hash: string) {
    location.hash = hash;
    setRoute(routeFromHash());
  }

  function openJob(id: string) {
    go(`#/job/${id}`);
  }

  return (
    <div>
      <header className="app-header">
        <div className="brand" onClick={() => go("")}>
          <span className="mark" />
          <h1>Browser Automation</h1>
        </div>
        <nav className="app-tabs">
          <button className={route.view === "dashboard" ? "active" : ""} onClick={() => go("")}>
            Dashboard
          </button>
          <button
            className={route.view === "organizations" ? "active" : ""}
            onClick={() => go("#/organizations")}
          >
            Organizations
          </button>
          <button className={route.view === "groups" ? "active" : ""} onClick={() => go("#/groups")}>
            Groups
          </button>
          <button className={route.view === "runs" ? "active" : ""} onClick={() => go("#/runs")}>
            Custom run
          </button>
          <button className={route.view === "settings" ? "active" : ""} onClick={() => go("#/settings")}>
            Settings
          </button>
        </nav>
        <div className="app-header-right">
          <EgressBadge />
          <AccountMenu account={account} onSignOut={onSignOut} onOpenSettings={() => go("#/settings")} />
        </div>
      </header>

      {route.view === "job" ? (
        <JobView jobId={route.jobId} onBack={() => go("")} />
      ) : route.view === "settings" ? (
        <div className="container">
          <SettingsView account={account} />
        </div>
      ) : route.view === "dashboard" ? (
        <div className="container">
          <DashboardView onOpenJob={openJob} />
        </div>
      ) : route.view === "organizations" ? (
        <div className="container">
          <OrganizationsView onOpenJob={openJob} />
        </div>
      ) : route.view === "runs" ? (
        <div className="container">
          <div className="job-toolbar">
            <div className="job-toolbar-title">
              <h2>Custom run</h2>
              <span className="hint">
                A one-off automation that starts straight away and isn't saved. For anything recurring, make a
                group.
              </span>
            </div>
          </div>
          <JobForm onCreated={openJob} />
          <div style={{ marginTop: 24 }}>
            <JobList onSelect={openJob} />
          </div>
        </div>
      ) : (
        <div className="container">
          <div className="groups-page-grid">
            <GroupList onOpenJob={openJob} />
            <PeoplePanel onOpenJob={openJob} />
          </div>
        </div>
      )}
    </div>
  );
}
