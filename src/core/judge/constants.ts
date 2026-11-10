/**
 * Jev constants shared by the client, the cache key and the eval (which may
 * not import the real client module; tests/backend/eval/predict-v1.test.ts).
 */

/** Pinned for reproducibility (D31): not the `jev-latest` alias. The answering `model` is recorded. */
export const JEV_MODEL = 'jev-1.14.0';
export const JEV_BASE_URL = 'https://api.typesafe.ai';
/** Per attempt (SDK default is 10 s). */
export const JEV_TIMEOUT_MS = 8_000;
/** Router calls must not hold up a report (5b.7). */
export const ROUTER_TIMEOUT_MS = 3_000;
/**
 * Overall budget for ONE J use inside one job (all its per-item requests
 * together; spec 0.11 "a Jev failure never blocks a view", review 5b M2).
 * Each request gets min(JEV_TIMEOUT_MS, what is left).
 */
export const JEV_USE_DEADLINE_MS = 10_000;
