import { useEffect, useState } from "react";
import type { EgressInfo } from "../api";
import * as api from "../api";

/**
 * What the outside world sees this platform as, in the top bar.
 *
 * It's measured, not configured — the API fetches it through the same proxy
 * the browsers use, so it reports where traffic actually leaves from rather
 * than where the settings say it should. That distinction is the whole
 * point: a proxy that is set but not working looks identical in a config
 * screen and completely different here.
 */
export function EgressBadge() {
  const [info, setInfo] = useState<EgressInfo | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setInfo(await api.getEgressInfo());
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // The egress only changes when settings change, so this is a slow poll
    // purely to notice a proxy that has fallen over.
    const t = setInterval(() => void load(), 300_000);
    return () => clearInterval(t);
  }, []);

  if (loading && !info) {
    return (
      <div className="egress-badge" title="Checking where traffic leaves from">
        <span className="dot checking" />
        <span className="egress-text">checking egress…</span>
      </div>
    );
  }

  if (!info || !info.ip) {
    return (
      <button className="egress-badge bad" onClick={() => void load()} title={info?.error ?? "Could not determine egress"}>
        <span className="dot" />
        <span className="egress-text">egress unknown — retry</span>
      </button>
    );
  }

  const place = [info.city, info.region, info.country].filter(Boolean).join(", ");

  return (
    <button
      className={`egress-badge${info.proxied ? " proxied" : ""}`}
      onClick={() => void load()}
      title={info.proxied ? "Traffic is routed through the configured proxy" : "Traffic leaves from this server directly"}
    >
      <span className="dot" />
      <span className="egress-text">
        <strong>{info.ip}</strong>
        {place && <span className="egress-place"> | {place}</span>}
      </span>
    </button>
  );
}
