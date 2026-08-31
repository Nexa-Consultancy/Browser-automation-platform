import { useEffect, useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobList } from "./components/JobList";
import { JobView } from "./components/JobView";
import { GroupList } from "./components/GroupList";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { EgressBadge } from "./components/EgressBadge";

type Route =
  | { view: "runs" }
  | { view: "groups" }
  | { view: "history" }
  | { view: "settings" }
  | { view: "job"; jobId: string };

// Groups is the landing view: scheduled automations are the main way this
// gets used, and a one-off custom run is the exception rather than the door
// you come in through.
function routeFromHash(): Route {
  const job = location.hash.match(/^#\/job\/(.+)$/);
  if (job) return { view: "job", jobId: job[1] };
  if (location.hash === "#/runs") return { view: "runs" };
  if (location.hash === "#/history") return { view: "history" };
  if (location.hash === "#/settings") return { view: "settings" };
  return { view: "groups" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
          <button
            className={route.view === "groups" ? "active" : ""}
            onClick={() => go("")}
          >
            Groups
          </button>
          <button
            className={route.view === "runs" ? "active" : ""}
            onClick={() => go("#/runs")}
          >
            Custom run
          </button>
          <button
            className={route.view === "history" ? "active" : ""}
            onClick={() => go("#/history")}
          >
            View more
          </button>
          <button
            className={route.view === "settings" ? "active" : ""}
            onClick={() => go("#/settings")}
          >
            Settings
          </button>
        </nav>
        <EgressBadge />
      </header>

      {route.view === "job" ? (
        <JobView jobId={route.jobId} onBack={() => go("")} />
      ) : route.view === "settings" ? (
        <div className="container">
          <SettingsView />
        </div>
      ) : route.view === "history" ? (
        <div className="container">
          <HistoryView onOpenJob={openJob} />
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
          <GroupList onOpenJob={openJob} />
        </div>
      )}
    </div>
  );
}
