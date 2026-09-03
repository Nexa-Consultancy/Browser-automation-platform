import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type { SessionAccount } from "./types";
import { APP_PATH, PUBLIC_PATHS, navigate, routeOf } from "./nav";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { ResetPassword } from "./pages/ResetPassword";
import { AppShell } from "./AppShell";

/**
 * Two layers of routing, and the split is deliberate.
 *
 * The PATH decides which product you are looking at: the public site (/,
 * /login, /signup, /reset) or the dashboard (/dashboard). Inside the
 * dashboard, the HASH keeps doing what it always did.
 *
 * This component owns one more thing: who is signed in. It resolves that
 * once on load, holds it, and refuses to render the app without it — so
 * there is exactly one place that can decide "logged in or not", rather
 * than every view guessing from a failed request.
 */
export default function App() {
  const [path, setPath] = useState(routeOf());
  const [account, setAccount] = useState<SessionAccount | null>(null);
  // Distinct from "no account": until the session request comes back we
  // don't know, and flashing the login page at somebody who is signed in is
  // worse than a moment of nothing.
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    const onPop = () => setPath(routeOf());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const { account } = await api.getSession();
      setAccount(account);
    } catch {
      // A network failure is not "signed out" — but there is nothing else
      // to show, so treat it as no session and let them try to log in.
      setAccount(null);
    } finally {
      setResolved(true);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  function onSignedIn(next: SessionAccount) {
    setAccount(next);
    navigate(APP_PATH);
  }

  async function onSignOut() {
    await api.logout().catch(() => {});
    setAccount(null);
    navigate(PUBLIC_PATHS.landing);
  }

  if (!resolved) {
    return (
      <div className="boot-screen">
        <span className="mark" />
        <span>Loading…</span>
      </div>
    );
  }

  switch (path) {
    case "landing":
      return <Landing signedIn={!!account} />;

    case "signup":
      // Already signed in? The signup form is meaningless — go to the app.
      if (account) {
        navigate(APP_PATH, true);
        return null;
      }
      return <Signup />;

    case "login":
      if (account) {
        navigate(APP_PATH, true);
        return null;
      }
      return <Login onSignedIn={onSignedIn} />;

    case "reset":
      // Reachable while signed in — someone can follow a reset link from an
      // email in the same browser — so this one is not redirected away.
      return <ResetPassword />;

    case "app":
      if (!account) {
        navigate(PUBLIC_PATHS.login, true);
        return null;
      }
      return <AppShell account={account} onSignOut={onSignOut} onSessionLost={() => setAccount(null)} />;
  }
}
