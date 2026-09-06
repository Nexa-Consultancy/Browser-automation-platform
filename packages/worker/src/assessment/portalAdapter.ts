/**
 * The seam between the quiz engine and a real portal.
 *
 * The engine below (see engine.ts) knows only this interface: find the
 * quizzes, tell me which are done, open one, read the question, click an
 * option, go next, submit, read the result, go back. It contains no
 * selector, no URL and no assumption about how any particular portal is
 * built — which is what makes "the portal details arrive later" a
 * configuration task rather than a rewrite.
 *
 * `ConfiguredPortalAdapter` below is the one implementation: it drives the
 * whole interface from an AssessmentPortalConfig (a template's stored
 * selectors). When the real portal's markup is supplied, filling that
 * config in IS the integration. If some future portal turns out to need
 * genuinely bespoke behaviour — a canvas-rendered question, an iframe per
 * quiz — it gets a second class implementing this same interface, and the
 * engine still does not change.
 */

import type { Locator, Page } from "playwright";
import {
  optionIdForIndex,
  readPortalStatus,
  type AssessmentPortalConfig,
  type ExtractedQuestion,
  type PortalQuizStatus,
  type QuestionOption,
} from "@automation/shared";
import { waitForSelector } from "../locators.js";

/** One quiz as it appears on the list, plus the element that opens it. */
export interface PortalQuiz {
  externalQuizId: string;
  quizName: string;
  portalStatus: PortalQuizStatus;
  /** The raw status text, kept for the log so an unmatched status is
   * diagnosable ("the card said 'Awaiting review', which no rule covers"). */
  statusText: string;
  /** Position in the list. The engine re-finds a quiz by index rather than
   * holding a Locator across a navigation, since the list is re-rendered
   * every time it returns to it. */
  index: number;
}

/**
 * The extracted question AND the elements its options map to.
 *
 * These travel together and never apart: the ids in `question.options` are
 * assigned by POSITION here, and `optionElements[i]` is the element that
 * position refers to. The model is sent only `question`; the elements never
 * leave this process. That pairing is the whole reason a hallucinated
 * option id cannot become a click on the wrong row.
 */
export interface QuestionWithElements {
  question: ExtractedQuestion;
  optionElements: Locator[];
}

export interface AssessmentPortalAdapter {
  /** Navigate to wherever the quizzes are listed. */
  openAssessmentList(): Promise<void>;
  /** Every quiz on the list, with whatever the portal says about each. */
  discoverQuizzes(): Promise<PortalQuiz[]>;
  /** Re-read one quiz's status without opening it — the check that runs
   * immediately before taking it, and again before any retry. */
  readQuizStatus(index: number): Promise<PortalQuiz | null>;
  openQuiz(index: number): Promise<void>;
  /** The current question and the elements its options map to. */
  readQuestion(questionNumber: number): Promise<QuestionWithElements>;
  /** Click one option, by its position in what readQuestion returned. */
  selectOption(elements: Locator[], index: number): Promise<void>;
  /** Whether the click landed, when the portal gives us a way to tell. */
  verifySelection(elements: Locator[], index: number): Promise<boolean | null>;
  /** True when there is another question after this one. */
  hasNext(): Promise<boolean>;
  goNext(): Promise<void>;
  submit(): Promise<void>;
  /** Whether the finished/result state is showing. The idempotency check:
   * this is what is asked before a submit is ever retried. */
  isSubmitted(): Promise<boolean>;
  waitForResult(): Promise<{ resultText: string; scoreText: string | null }>;
  returnToList(): Promise<void>;
}

/** Everything a configured adapter needs beyond the config itself. */
export interface AdapterContext {
  page: () => Page;
  timeoutMs: number;
  /** Where the navigation workflow left the browser. Used as the fallback
   * "back to the list" when the portal config doesn't name one. */
  listUrl: () => string;
}

export class PortalConfigError extends Error {
  constructor(field: string) {
    super(
      `the quiz template does not define "${field}" — fill it in under Assignments → Quiz templates ` +
        `before running this group`,
    );
    this.name = "PortalConfigError";
  }
}

const DEFAULT_RESULT_TIMEOUT_MS = 30_000;

/**
 * A portal driven entirely by its stored configuration.
 *
 * Every method below reads a selector out of the config and resolves it
 * through the platform's OWN locator code (waitForSelector), so a quiz page
 * gets the same "poll each candidate, prefer the visible one" treatment
 * every ordinary step already gets — including whatever that code learns
 * next. A missing selector raises PortalConfigError naming the field, never
 * a guess and never a silent skip.
 */
export class ConfiguredPortalAdapter implements AssessmentPortalAdapter {
  constructor(
    private readonly config: AssessmentPortalConfig,
    private readonly ctx: AdapterContext,
  ) {}

  private get page(): Page {
    return this.ctx.page();
  }

  private need(value: string | undefined, field: string): string {
    if (!value) throw new PortalConfigError(field);
    return value;
  }

  async openAssessmentList(): Promise<void> {
    if (this.config.assessmentUrl) {
      await this.page.goto(this.config.assessmentUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(this.ctx.timeoutMs, 60_000),
      });
    }
    // Wait for the list itself where the config names one, so discovery
    // does not read an empty page that is still fetching.
    if (this.config.quizListSelector) {
      await waitForSelector(this.page, this.config.quizListSelector, this.ctx.timeoutMs);
    } else {
      await waitForSelector(this.page, this.need(this.config.quizCardSelector, "quizCardSelector"), this.ctx.timeoutMs);
    }
  }

  /** The quiz cards, scoped inside the list container when one is named. */
  private cards(): Locator {
    const card = this.need(this.config.quizCardSelector, "quizCardSelector");
    return this.config.quizListSelector
      ? this.page.locator(this.config.quizListSelector).locator(card)
      : this.page.locator(card);
  }

  private async readCard(card: Locator, index: number): Promise<PortalQuiz> {
    const name = this.config.quizNameSelector
      ? ((await card.locator(this.config.quizNameSelector).first().textContent().catch(() => null)) ?? "")
      : ((await card.textContent().catch(() => null)) ?? "");

    const statusText = this.config.completion?.statusSelector
      ? ((await card
          .locator(this.config.completion.statusSelector)
          .first()
          .textContent()
          .catch(() => null)) ?? "")
      : "";

    let hasMarker = false;
    if (this.config.completion?.completedMarkerSelector) {
      hasMarker = (await card.locator(this.config.completion.completedMarkerSelector).count().catch(() => 0)) > 0;
    }

    // The portal's own id where it publishes one. Without it a quiz is
    // matched across runs by its NAME, which is why quizIdAttribute is
    // worth filling in: a renamed quiz otherwise reads as a new one.
    let externalId = "";
    if (this.config.quizIdAttribute) {
      externalId = (await card.getAttribute(this.config.quizIdAttribute).catch(() => null)) ?? "";
    }

    const quizName = name.trim().replace(/\s+/g, " ").slice(0, 300);
    return {
      externalQuizId: externalId.trim() || quizName || `quiz-${index + 1}`,
      quizName: quizName || `Quiz ${index + 1}`,
      portalStatus: readPortalStatus(statusText, this.config.completion, hasMarker),
      statusText: statusText.trim(),
      index,
    };
  }

  async discoverQuizzes(): Promise<PortalQuiz[]> {
    const cards = this.cards();
    const count = await cards.count();
    const out: PortalQuiz[] = [];
    for (let i = 0; i < count; i++) {
      out.push(await this.readCard(cards.nth(i), i));
    }
    return out;
  }

  async readQuizStatus(index: number): Promise<PortalQuiz | null> {
    const cards = this.cards();
    if ((await cards.count()) <= index) return null;
    return this.readCard(cards.nth(index), index);
  }

  async openQuiz(index: number): Promise<void> {
    const card = this.cards().nth(index);
    const opener = this.config.quizOpenSelector ? card.locator(this.config.quizOpenSelector).first() : card;
    await opener.click({ timeout: this.ctx.timeoutMs });
    // The question is the thing that proves the quiz actually opened; a
    // click that navigated nowhere fails here rather than three steps later
    // with a confusing message about options.
    await waitForSelector(
      this.page,
      this.need(this.config.question?.questionSelector, "question.questionSelector"),
      this.ctx.timeoutMs,
    );
  }

  async readQuestion(questionNumber: number): Promise<QuestionWithElements> {
    const questionSelector = this.need(this.config.question?.questionSelector, "question.questionSelector");
    const optionsSelector = this.need(this.config.question?.optionsSelector, "question.optionsSelector");

    const questionLoc = await waitForSelector(this.page, questionSelector, this.ctx.timeoutMs);
    const questionText = ((await questionLoc.textContent()) ?? "").trim().replace(/\s+/g, " ");

    await waitForSelector(this.page, optionsSelector, this.ctx.timeoutMs);
    const optionLoc = this.page.locator(optionsSelector);
    const count = await optionLoc.count();

    const options: QuestionOption[] = [];
    const optionElements: Locator[] = [];
    for (let i = 0; i < count; i++) {
      const row = optionLoc.nth(i);
      const textSource = this.config.question?.optionTextSelector
        ? row.locator(this.config.question.optionTextSelector).first()
        : row;
      const text = ((await textSource.textContent().catch(() => null)) ?? "").trim().replace(/\s+/g, " ");
      // The id is the POSITION, always. This is the pairing the whole
      // safety story rests on: the model answers with a letter, and the
      // letter is an index into optionElements, never a text search.
      options.push({ id: optionIdForIndex(i), text });
      optionElements.push(row);
    }

    const totalQuestions = await this.readTotalQuestions();

    return {
      question: {
        questionText,
        questionType: this.config.question?.questionType ?? "single_choice",
        options,
        questionNumber,
        totalQuestions,
      },
      optionElements,
    };
  }

  /** "Question 3 of 10" -> 10. Only used for the log and for knowing when
   * Submit is due, so an unreadable counter is a null, not a failure. */
  private async readTotalQuestions(): Promise<number | null> {
    if (!this.config.question?.progressSelector) return null;
    const text = await this.page
      .locator(this.config.question.progressSelector)
      .first()
      .textContent()
      .catch(() => null);
    if (!text) return null;
    const m = text.match(/(?:of|\/)\s*(\d+)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async selectOption(elements: Locator[], index: number): Promise<void> {
    const row = elements[index];
    if (!row) throw new Error(`option ${index} is not on the page`);
    const clickTarget = this.config.question?.optionClickSelector
      ? row.locator(this.config.question.optionClickSelector).first()
      : row;
    await clickTarget.click({ timeout: this.ctx.timeoutMs });
  }

  /**
   * Whether the option actually took.
   *
   * Returns null — not false — when the portal gives no way to tell. The
   * distinction matters: "I checked and it isn't selected" is a retry,
   * "there is nothing to check" is not a failure, and collapsing the two
   * would either retry every question or trust every click.
   */
  async verifySelection(elements: Locator[], index: number): Promise<boolean | null> {
    const selected = this.config.question?.selectedOptionSelector;
    if (!selected) return null;
    const row = elements[index];
    if (!row) return false;
    // Two shapes are common: a marker INSIDE the chosen row, and a class on
    // the row itself. Try the inner one, then the row.
    const inner = await row.locator(selected).count().catch(() => 0);
    if (inner > 0) return true;
    const isSelf = await row.evaluate((el, sel) => el.matches(sel), selected).catch(() => null);
    return isSelf;
  }

  async hasNext(): Promise<boolean> {
    if (!this.config.nextSelector) return false;
    const next = this.page.locator(this.config.nextSelector).first();
    if ((await next.count().catch(() => 0)) === 0) return false;
    // A Next that is present but disabled means "this is the last one" on
    // most portals, so it counts as no-next rather than as a stuck run.
    const visible = await next.isVisible().catch(() => false);
    if (!visible) return false;
    return await next.isEnabled().catch(() => true);
  }

  async goNext(): Promise<void> {
    const next = this.need(this.config.nextSelector, "nextSelector");
    const loc = await waitForSelector(this.page, next, this.ctx.timeoutMs);
    await loc.click({ timeout: this.ctx.timeoutMs });
  }

  async submit(): Promise<void> {
    const submit = this.need(this.config.submitSelector, "submitSelector");
    const loc = await waitForSelector(this.page, submit, this.ctx.timeoutMs);
    await loc.click({ timeout: this.ctx.timeoutMs });

    // A confirmation dialog, where the portal has one. Probed briefly
    // rather than waited on: a portal without one must not cost the full
    // timeout on every submission.
    if (this.config.confirmSubmitSelector) {
      const confirm = this.page.locator(this.config.confirmSubmitSelector).first();
      await confirm.click({ timeout: 5_000 }).catch(() => {});
    }
  }

  /**
   * Is the quiz already submitted?
   *
   * The single most important question in this file. Its answer decides
   * whether a submission is retried after a crash, so it never guesses: no
   * result selector configured means "we cannot tell", which the engine
   * treats as "it may have gone through" and refuses to retry.
   */
  async isSubmitted(): Promise<boolean> {
    if (!this.config.resultSelector) throw new PortalConfigError("resultSelector");
    const loc = this.page.locator(this.config.resultSelector).first();
    if ((await loc.count().catch(() => 0)) === 0) return false;
    return await loc.isVisible().catch(() => false);
  }

  async waitForResult(): Promise<{ resultText: string; scoreText: string | null }> {
    const resultSelector = this.need(this.config.resultSelector, "resultSelector");
    const timeout = this.config.resultTimeoutMs ?? Math.max(this.ctx.timeoutMs, DEFAULT_RESULT_TIMEOUT_MS);
    const loc = await waitForSelector(this.page, resultSelector, timeout);
    const resultText = ((await loc.textContent().catch(() => null)) ?? "").trim().replace(/\s+/g, " ");

    let scoreText: string | null = null;
    if (this.config.scoreSelector) {
      const raw = await this.page
        .locator(this.config.scoreSelector)
        .first()
        .textContent()
        .catch(() => null);
      scoreText = raw ? raw.trim().replace(/\s+/g, " ") : null;
    }
    return { resultText, scoreText };
  }

  async returnToList(): Promise<void> {
    if (this.config.backToListSelector) {
      const loc = await waitForSelector(this.page, this.config.backToListSelector, this.ctx.timeoutMs);
      await loc.click({ timeout: this.ctx.timeoutMs });
    } else {
      // No explicit control: go back to where the list was. Re-navigating
      // is more reliable than browser Back, which on a single-page portal
      // often lands on a stale, half-rendered list.
      const url = this.config.assessmentUrl || this.ctx.listUrl();
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(this.ctx.timeoutMs, 60_000) });
    }
    await this.openAssessmentList();
  }
}
