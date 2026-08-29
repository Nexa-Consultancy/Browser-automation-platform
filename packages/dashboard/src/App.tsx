import { useEffect, useState } from "react";
import { JobForm } from "./components/JobForm";
import { JobList } from "./components/JobList";
import { JobView } from "./components/JobView";

function jobIdFromHash(): string | null {
  const m = location.hash.match(/^#\/job\/(.+)$/);
  return m ? m[1] : null;
}

export default function App() {
  const [jobId, setJobId] = useState<string | null>(jobIdFromHash());

  useEffect(() => {
    const onHashChange = () => setJobId(jobIdFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function openJob(id: string) {
    location.hash = `#/job/${id}`;
    setJobId(id);
  }

  function goHome() {
    location.hash = "";
    setJobId(null);
  }

  return (
    <div>
      <header className="app-header">
        <div className="brand" onClick={goHome}>
          <span className="mark" />
          <h1>Browser Automation</h1>
        </div>
        <div className="system-status">
          <span className="dot" />
          system ready
        </div>
      </header>

      {jobId ? (
        <JobView jobId={jobId} onBack={goHome} />
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
