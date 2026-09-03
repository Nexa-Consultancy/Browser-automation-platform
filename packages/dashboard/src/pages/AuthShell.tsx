import type { ReactNode } from "react";
import { PUBLIC_PATHS, navigate } from "../nav";

/**
 * The frame every signed-out form shares — one brand mark, one card, one
 * cross-link at the bottom. Login and Sign up each carry a link to the
 * other, which is the whole reason this is a shared shell rather than three
 * separate layouts that drift apart.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-page">
      <button
        type="button"
        className="auth-brand"
        onClick={() => navigate(PUBLIC_PATHS.landing)}
        title="Back to the home page"
      >
        <span className="mark" />
        Browser Automation
      </button>

      <div className="auth-card">
        <h1>{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </div>

      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}
