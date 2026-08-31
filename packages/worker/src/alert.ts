import { ALERT_CHANNEL, newRedisConnection } from "@automation/queue";

const pub = newRedisConnection();

/**
 * Announces a failure for the API to turn into an email and a log row.
 *
 * Fire-and-forget on purpose: reporting a problem must never be able to
 * cause one, so a Redis hiccup here is swallowed rather than surfacing as a
 * second failure on top of the one being reported.
 */
export function publishAlert(input: {
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
  errorTrace?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  userName?: string | null;
  groupName?: string | null;
}): void {
  pub.publish(ALERT_CHANNEL, JSON.stringify(input)).catch(() => {});
}
