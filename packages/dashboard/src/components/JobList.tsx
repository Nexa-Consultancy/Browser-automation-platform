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
      <div className="eyebrow">Recent runs</div>
      <div className="job-list">
        {jobs.map((j) => (
          <div className="job-list-item" key={j.id} onClick={() => onSelect(j.id)}>
            <span className="job-name">
              {j.name} <span className="target">— {j.targetUrl}</span>
            </span>
            <StatusBadge status={j.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
