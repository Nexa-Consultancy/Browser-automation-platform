import { ALERT_CHANNEL, newRedisConnection } from "@automation/queue";
import { raiseAlert, type AlertInput } from "./alerts.js";

/**
 * Bridges worker failures to the alert engine.
 *
 * The worker runs in its own container and is deliberately kept ignorant of
 * SMTP credentials — it publishes what went wrong, and the API (which owns
 * settings) decides whether that becomes an email. This also means alerting
 * keeps working when workers are scaled out, since they all publish to the
 * same channel and one place sends the mail.
 */
export function startAlertListener(log: { info: (m: string) => void; error: (m: string) => void }): () => void {
  const sub = newRedisConnection();

  void sub.subscribe(ALERT_CHANNEL).then(() => {
    log.info(`alert listener subscribed to "${ALERT_CHANNEL}"`);
  });

  sub.on("message", (_channel, payload) => {
    let alert: AlertInput;
    try {
      alert = JSON.parse(payload) as AlertInput;
    } catch {
      return;
    }
    // Never let a bad alert take down the listener.
    void raiseAlert(alert).catch((e) => log.error(`alert dispatch failed: ${String(e)}`));
  });

  sub.on("error", (e) => log.error(`alert listener error: ${String(e)}`));

  return () => {
    void sub.quit();
  };
}
