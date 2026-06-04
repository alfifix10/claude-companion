/**
 * auto-resume — decide whether a finished task should auto-continue.
 *
 * A "smart stop": when the agent hits the absolute ACTION budget on a task
 * that was making genuine, varied progress (a long batch, not a spin), the
 * host flags the result `resumable`. The panel then continues it
 * automatically — up to a small bound — instead of nagging the user to press
 * "اكمل". Loops / error streaks / no-progress spins / timeouts are NOT
 * resumable, so real problems still stop.
 *
 * The bound is the safety rail: getting it wrong (e.g. an off-by-one) would
 * mean infinite auto-resume and a burned Max quota — hence this is a pure,
 * unit-tested predicate.
 */
export const MAX_AUTO_RESUMES = 3;
export function shouldAutoResume(result, resumeCount, max = MAX_AUTO_RESUMES) {
    return !!result && result.resumable === true && resumeCount < max;
}
