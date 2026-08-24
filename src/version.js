/**
 * Comparing app version strings.
 *
 * Needed because targeting is written as "1.4.0 and above", and a string
 * comparison puts 1.10.0 before 1.9.0 - which would show an announcement to
 * exactly the people it was meant to exclude.
 *
 * Handles the shapes a store build actually carries: "1.4", "1.4.0",
 * "1.4.0+27" (Flutter's build suffix), and a leading "v".
 */

/**
 * Splits into numeric parts, ignoring any build metadata.
 *
 * Anything non-numeric becomes 0 rather than NaN: a version the server cannot
 * parse should compare as "very old" and therefore see the safest content, not
 * poison every comparison it takes part in.
 */
function parts(version) {
  const cleaned = String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    // Flutter's build number, and semver pre-release tags.
    .split(/[+-]/)[0];

  return cleaned.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Missing segments count as zero, so "1.4" and "1.4.0" are the same version -
 * which is what someone typing the short form means.
 */
export function compareVersions(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` falls within an inclusive range.
 *
 * A null bound means unbounded on that side. An unknown client version - no
 * `?version=` on the request - satisfies only an unbounded range: targeting
 * "1.4.0 and above" must not reach a client that never said what it runs.
 */
export function versionInRange(version, min, max) {
  if (!min && !max) return true;
  if (!version) return false;

  if (min && compareVersions(version, min) < 0) return false;
  if (max && compareVersions(version, max) > 0) return false;
  return true;
}
