import { useEffect, useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobList } from "./components/JobList";
import { JobView } from "./components/JobView";
import { GroupList } from "./components/GroupList";

type Route = { view: "runs" } | { view: "groups" } | { view: "job"; jobId: string };

function routeFromHash(): Route {
  const job = location.hash.match(/^#\/job\/(.+)$/);
  if (job) return { view: "job", jobId: job[1] };
  if (location.hash === "#/groups") return { view: "groups" };
  return { view: "runs" };
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
            className={route.view === "groups" ? "" : "active"}
            onClick={() => go("")}
          >
            Runs
          </button>
          <button
            className={route.view === "groups" ? "active" : ""}
            onClick={() => go("#/groups")}
          >
            Groups
          </button>
        </nav>
        <div className="system-status">
          <span className="dot" />
          system ready
        </div>
      </header>

      {route.view === "job" ? (
        <JobView jobId={route.jobId} onBack={() => go("")} />
      ) : route.view === "groups" ? (
        <div className="container">
          <GroupList onOpenJob={openJob} />
        </div>
      ) : (
        <div className="container">
          <JobForm onCreated={openJob} />
          <div style={{ marginTop: 24 }}>
            <JobList onSelect={openJob} />
          </div>
        </div>
      )}
    </div>
  );
}
