/**
 * Top-level routing is by PATH (/, /login, /signup, /reset, /dashboard);
 * routing *inside* the dashboard stays on the hash it always used. Two
 * levels rather than one because the public site and the app are genuinely
 * different things — a landing page at "/#/" would be a strange URL to put
 * on a domain, and rewriting every in-app route was needless churn.
 *
 * nginx already serves index.html for any unmatched path (try_files), so a
 * deep link like /signup loads the SPA rather than 404ing.
 */
export type PublicRoute = "landing" | "login" | "signup" | "reset";

export const PUBLIC_PATHS: Record<PublicRoute, string> = {
  landing: "/",
  login: "/login",
  signup: "/signup",
  reset: "/reset",
};

/** Where the app itself lives. Anything not recognised as public routes
 * here, so an old bookmark still lands somewhere sensible. */
export const APP_PATH = "/dashboard";

export function currentPath(): string {
  // Trailing slashes are noise: "/login/" and "/login" are the same page.
  const p = location.pathname.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function routeOf(path = currentPath()): PublicRoute | "app" {
  switch (path) {
    case PUBLIC_PATHS.landing:
      return "landing";
    case PUBLIC_PATHS.login:
      return "login";
    case PUBLIC_PATHS.signup:
      return "signup";
    case PUBLIC_PATHS.reset:
      return "reset";
    default:
      return "app";
  }
}

/**
 * Client-side navigation. pushState alone does not tell anyone it happened,
 * so a popstate event is dispatched by hand — that is what App is already
 * listening to for the browser's own Back button, and reusing it keeps one
 * code path instead of two.
 */
export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
