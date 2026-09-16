/**
 * Daily housekeeping: old gameplay events, and imports nobody confirmed.
 *
 * Runs once at boot and then every day. Each job is separate, so one failing
 * does not stop the other, and failures are logged rather than thrown — a
 * missed prune is a slightly larger table, not a reason to stop serving.
 */

const DAY_MS = 86_400_000;

export function createMaintenance({ repo, events, pendingImports, images, audio, retentionDays, log = console }) {
  async function dropStaleImports() {
    let removed = 0;
    for (const { id, payload } of pendingImports.stale()) {
      for (const media of payload.media ?? []) {
        // Only files no question took: a confirmed import may have used some.
        if (repo.mediaInUse(media.file)) continue;
        await (media.kind === 'audio' ? audio : images).remove(media.file);
      }
      pendingImports.remove(id);
      removed++;
    }
    return removed;
  }

  async function run() {
    try {
      const pruned = events.prune(retentionDays);
      if (pruned) log.info?.(`Pruned ${pruned} gameplay events older than ${retentionDays} days.`);
    } catch (err) {
      log.error?.('Event prune failed:', err);
    }
    try {
      const dropped = await dropStaleImports();
      if (dropped) log.info?.(`Removed ${dropped} unconfirmed import(s) and their unused files.`);
    } catch (err) {
      log.error?.('Import cleanup failed:', err);
    }
  }

  function start() {
    run();
    const timer = setInterval(run, DAY_MS);
    // Must not hold the process open on shutdown.
    timer.unref?.();
    return timer;
  }

  return { run, start, dropStaleImports };
}
