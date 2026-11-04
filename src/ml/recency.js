/**
 * THREADLINE — recency.js
 *
 * Shared "how long since this tab was last touched" calculation.
 * Used for the UI's visual decay: fading stale tabs so the user notices them.
 *
 * ─── THE PSYCHOLOGY (Zeigarnik effect) ───────────────────────────────────
 * The Zeigarnik effect describes how unfinished tasks stay mentally
 * "active" — they keep intruding — while finished ones fade from attention.
 * An open tab is an unfinished intention. One you touched 90 seconds ago
 * is almost certainly still a live thought. One you haven't touched in
 * 40 minutes probably isn't anymore — it's residue from an earlier thought.
 *
 * Fading stale tabs visually gives the user a passive cue to reconsider
 * them, without forcing a decision. Compare this to browsers that
 * auto-discard or auto-close "inactive" tabs after a fixed time — that
 * forces the decision and tends to produce reactance ("don't touch my
 * tabs"). A fade is just information; closing is still the user's call.
 */

export const RECENCY_CAP_MS = 30 * 60 * 1000; // 30 minutes

/**
 * @param {number} lastActive - epoch ms this tab was last the active tab
 * @param {number} [now] - epoch ms "now" (injectable so tests are deterministic)
 * @returns {number} 1 = touched just now, 0 = stale (30+ minutes untouched)
 */
export function computeRecencyNorm(lastActive, now = Date.now()) {
  if (!lastActive) return 0; // never recorded → treat as fully stale
  const elapsed = Math.max(0, now - lastActive);
  return Math.max(0, 1 - elapsed / RECENCY_CAP_MS);
}

/**
 * Human-readable "how long ago" string for tooltips.
 * @param {number} lastActive
 * @param {number} [now]
 * @returns {string}
 */
export function formatIdleDuration(lastActive, now = Date.now()) {
  if (!lastActive) return 'unknown';
  const minutes = Math.floor(Math.max(0, now - lastActive) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `idle ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `idle ${hours}h`;
}
