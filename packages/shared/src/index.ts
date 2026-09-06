export * from "./types.js";
export * from "./stepParser.js";
export * from "./csv.js";
export * from "./time.js";

// ---------- Assignments module ----------
// Template formats (the normalized-workflow layer), the assessment domain,
// and the AI seam. All additive: nothing above this line changed shape.
export * from "./templateTypes.js";
export * from "./jsonWorkflow.js";
export * from "./tsTemplate.js";
export * from "./portalConfig.js";
export * from "./assessmentTypes.js";
export * from "./quizState.js";
export * from "./questionPayload.js";
export * from "./aiAnswer.js";
export * from "./aiConfig.js";
export * from "./aiProviders.js";
export * from "./aiRouter.js";

/** A one-user run whose profile is a specific PlatformUser's own persistent
 * dir (see the worker's profilePlanFor). Auto-fills email/password, then
 * stops for the operator to finish "Stay signed in?"/2FA by hand via the
 * live view. */
export const USER_LOGIN_CAPTURE_JOB_NAME = "User login capture";

/** The seeded step_templates row (see packages/db/src/schema.sql) that
 * routes/users.ts reads for the login-capture script — editable from
 * Settings → Templates like any other template. */
export const AUTO_LOGIN_TEMPLATE_ID = "00000000-0000-0000-0000-000000000002";
