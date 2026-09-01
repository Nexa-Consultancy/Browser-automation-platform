export * from "./types.js";
export * from "./stepParser.js";
export * from "./csv.js";
export * from "./time.js";

/** A one-user run whose profile IS the shared Teams master profile. Named so
 * the worker routes its profile to the master dir and the job view labels it
 * clearly. Signing in here once seeds every group via "Apply master login". */
export const MASTER_LOGIN_JOB_NAME = "Teams master login";
