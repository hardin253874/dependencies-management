/**
 * Privacy guard (V2_STAGE5_SPEC 5b.3 / 5b.9). Runs before the cache and
 * before any client call; a refusal is a `JudgePrivacyError` and the caller
 * falls back to today's behaviour.
 *
 * Refuses, in this order:
 * 1. the global switch off, or this use's switch off (router / J flag);
 * 2. the per-project switch `judge: 'off'`;
 * 3. an eval case `real.ts` classifies private (always, no opt-in);
 * 4. a payload class wider than the use's class in `USE_CLASS`
 *    (e.g. `source` or `public-text` for router / J5 / J6);
 * 5. a private project, or one whose privacy is unknown (D30: missing =
 *    private): NOTHING goes to TypeSafe, except J1–J3 source payloads when the
 *    project carries the explicit per-project opt-in (`sourceOptIn`). This is
 *    stricter than spec 5b.9 (which let J4–J8 through for private projects):
 *    the stage brief says nothing at all reaches TypeSafe for a private
 *    project unless opted in for J1–J3. Recorded in the 5b dev notes.
 */
import { JudgePrivacyError, USE_CLASS, type JudgeSubject, type JudgeSwitches, type JudgeUse, type PayloadClass } from './types';

const CLASS_RANK: Readonly<Record<PayloadClass, number>> = { metadata: 0, 'public-text': 1, source: 2 };
const SOURCE_USES: readonly JudgeUse[] = Object.freeze(['J1', 'J2', 'J3']);

export function isUseSwitchedOn(use: JudgeUse, switches: JudgeSwitches): boolean {
  if (!switches.enabled) return false;
  return use === 'router' ? switches.router : switches.flags[use] === true;
}

export function assertAllowed(opts: { use: JudgeUse; payloadClass: PayloadClass; subject: JudgeSubject; switches: JudgeSwitches }): void {
  const { use, payloadClass, subject, switches } = opts;
  if (!switches.enabled) throw new JudgePrivacyError('Jev is off (judge.enabled = false)');
  if (!isUseSwitchedOn(use, switches)) throw new JudgePrivacyError(`Jev ${use} is off`);
  if (subject.judge === 'off') throw new JudgePrivacyError('Jev is off for this project');
  if (subject.privateEvalCase === true) throw new JudgePrivacyError('private eval case: nothing is sent to TypeSafe');
  if (CLASS_RANK[payloadClass] > CLASS_RANK[USE_CLASS[use]]) {
    throw new JudgePrivacyError(`${use} is ${USE_CLASS[use]}-only; refusing a ${payloadClass} payload`);
  }
  if (subject.privacy !== 'public') {
    const optedIn = subject.privacy === 'private' && subject.sourceOptIn === true && SOURCE_USES.includes(use);
    if (!optedIn) {
      throw new JudgePrivacyError(
        subject.privacy === undefined ? 'project privacy unknown (treated as private): nothing is sent to TypeSafe' : 'private project: nothing is sent to TypeSafe'
      );
    }
  }
}

/** True when the subject can use Jev at all for `use` (no payload check). */
export function judgeAllowedFor(use: JudgeUse, subject: JudgeSubject, switches: JudgeSwitches): boolean {
  try {
    assertAllowed({ use, payloadClass: 'metadata', subject, switches });
    return true;
  } catch {
    return false;
  }
}
