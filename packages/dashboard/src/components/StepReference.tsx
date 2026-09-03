/**
 * What you are allowed to write in a step script.
 *
 * This exact list previously appeared three times — on the custom-run form,
 * in the group editor and in the template editor — each as a single run-on
 * paragraph of names separated by middots. It was accurate and effectively
 * unreadable: you could not find "how do I wait for something" in it
 * without reading the whole thing, and the three copies had already drifted
 * apart (only one of them mentioned `open URL`, only one explained what the
 * "if visible" forms are actually for).
 *
 * One collapsed table instead. Closed, it costs a line; open, every step is
 * a row you can scan down with a plain-English description beside it.
 */

interface StepDoc {
  syntax: string;
  what: string;
}

const ACTIONS: StepDoc[] = [
  { syntax: "click Sign in", what: "Click a button, link or menu item with that wording." },
  { syntax: "fill Email with {{email}}", what: "Type a value into the field with that label or placeholder." },
  { syntax: "type hello", what: "Type text wherever the cursor already is." },
  { syntax: "select India in Country", what: "Choose an option from a dropdown." },
  { syntax: "check Remember me", what: "Tick a checkbox (uncheck X clears one)." },
  { syntax: "press Enter", what: "Press a single key — Enter, Tab, Escape, an arrow key." },
  { syntax: "open https://…", what: "Go somewhere else mid-script. The link above is already opened as step 1." },
  { syntax: "screenshot", what: "Capture the page into this run's live view." },
];

const WAITS: StepDoc[] = [
  { syntax: 'wait for text "Welcome"', what: "Pause until that wording appears on the page." },
  { syntax: 'wait for element ".btn"', what: "Pause until a CSS selector matches something." },
  { syntax: "wait 10 seconds", what: "Pause for a fixed time. Rarely needed — every step already waits." },
  { syntax: "wait for video", what: "Pause until every video on the page has finished playing." },
];

const OPTIONAL: StepDoc[] = [
  {
    syntax: "click if visible Accept cookies",
    what: "Same as click, but moves on instead of failing when it never appears.",
  },
  {
    syntax: "fill if visible Name with {{name}}",
    what: "Same as fill, for a field that only shows up sometimes.",
  },
];

function Rows({ rows }: { rows: StepDoc[] }) {
  return (
    <>
      {rows.map((r) => (
        <div className="step-ref-row" key={r.syntax}>
          <code>{r.syntax}</code>
          <span>{r.what}</span>
        </div>
      ))}
    </>
  );
}

export function StepReference({ showTemplating = true }: { showTemplating?: boolean }) {
  return (
    <details className="step-ref">
      <summary>What can I write here?</summary>

      <div className="step-ref-body">
        <p className="step-ref-lead">
          One instruction per line, in plain English. Every step waits for what it needs on its own, so you almost
          never have to add a pause.
        </p>

        <div className="step-ref-group">Doing something</div>
        <Rows rows={ACTIONS} />

        <div className="step-ref-group">Waiting</div>
        <Rows rows={WAITS} />

        <div className="step-ref-group">Only if it shows up</div>
        <Rows rows={OPTIONAL} />

        {showTemplating && (
          <p className="step-ref-lead">
            {"{{name}}"} fills in each user's own name, {"{{url}}"} the link above, and any other{" "}
            {"{{column}}"} the matching column from that user's CSV row. Single braces work too.
          </p>
        )}
      </div>
    </details>
  );
}
