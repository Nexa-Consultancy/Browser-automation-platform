import { useEffect, useState } from "react";
import type { Job } from "../types";
import * as api from "../api";
import { StatusBadge } from "./StatusBadge";

export function JobList({ onSelect }: { onSelect: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    api.listJobs().then(({ jobs }) => setJobs(jobs));
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div>
      <h3 style={{ marginBottom: 4 }}>Recent runs</h3>
      <div className="job-list">
        {jobs.map((j) => (
          <div className="job-list-item" key={j.id} onClick={() => onSelect(j.id)}>
            <span>
              {j.name} <span className="hint">— {j.targetUrl}</span>
            </span>
            <StatusBadge status={j.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
