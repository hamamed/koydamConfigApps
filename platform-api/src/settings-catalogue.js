/**
 * Which settings each service exposes, and what kind of thing each one is.
 *
 * Declared here rather than discovered, for three reasons. The panel renders
 * its forms from this without knowing anything about the services. Values are
 * validated against it on write, so a rate limit cannot be set to "banana".
 * And it is the list of what has *moved* - anything absent stays in .env,
 * which makes the boundary readable instead of implied.
 *
 * ## What is deliberately not here
 *
 * The bootstrap set: POSTGRES_URL, REDIS_URL, SERVICE_TOKEN, PLATFORM_URL,
 * SESSION_SECRET, PORT, HOST, DATA_DIR, STORAGE_DIR, SETTINGS_KEY. A service
 * needs all of them before it can ask anything for its settings, so storing
 * them here would be asking the database for its own address.
 *
 * Also absent: ADMIN_KEY, ADMIN_USERNAME, ADMIN_PASSWORD. Those are superseded
 * by the single sign-in and should be deleted, not relocated - a dead
 * credential that still works is worse than one that does not exist.
 */

/**
 * type       number | boolean | text | secret | select
 * restart    true when the service only reads it at boot
 * secret     stored encrypted, never returned, shown as ••••1234
 */
export const CATALOGUE = {
  brawl: {
    name: 'Brawl Stats API',
    groups: [
      {
        title: 'Credentials',
        settings: [
          {
            key: 'BRAWL_API_TOKEN',
            label: 'Supercell API token',
            type: 'secret',
            restart: false,
            help: 'From developer.brawlstars.com. Tied to this server’s IP.',
          },
          {
            key: 'PUBLIC_API_KEY',
            label: 'Client API key',
            type: 'secret',
            restart: false,
            help: 'What the app sends. Changing it locks out every build using the old one.',
          },
        ],
      },
      {
        title: 'Crawler',
        settings: [
          { key: 'CRAWLER_ENABLED', label: 'Crawler on', type: 'boolean', restart: false,
            help: 'Turn off while Supercell is rate limiting, without a deploy.' },
          { key: 'CRAWLER_INTERVAL_MIN', label: 'Interval (minutes)', type: 'number',
            min: 5, max: 1440, restart: false,
            help: 'How often a crawl starts. Lower means fresher data and more API calls.' },
          { key: 'CRAWLER_PLAYERS', label: 'Players per region', type: 'number',
            min: 25, max: 200, restart: false },
          { key: 'CRAWLER_CONCURRENCY', label: 'Concurrency', type: 'number',
            min: 1, max: 16, restart: false,
            help: 'Parallel requests. Too high and Supercell throttles the whole token.' },
          { key: 'CRAWLER_DISCOVERY', label: 'Discovered per cycle', type: 'number',
            min: 0, max: 500, restart: false },
          { key: 'CRAWLER_PROFILES', label: 'Profiles per cycle', type: 'number',
            min: 0, max: 200, restart: false },
          { key: 'CRAWLER_SEARCHED', label: 'Searched per cycle', type: 'number',
            min: 0, max: 200, restart: false },
          { key: 'CRAWLER_MIN_SAMPLE', label: 'Minimum sample', type: 'number',
            min: 1, max: 500, restart: false,
            help: 'Below this a brawler is left out of the tier list rather than shown on thin data.' },
        ],
      },
      {
        title: 'Cache lifetimes (seconds)',
        settings: [
          { key: 'TTL_PLAYER', label: 'Player', type: 'number', min: 10, max: 86400, restart: false },
          { key: 'TTL_BATTLELOG', label: 'Battle log', type: 'number', min: 10, max: 86400, restart: false },
          { key: 'TTL_CLUB', label: 'Club', type: 'number', min: 10, max: 86400, restart: false },
          { key: 'TTL_BRAWLERS', label: 'Brawlers', type: 'number', min: 60, max: 604800, restart: false },
          { key: 'TTL_EVENTS', label: 'Events', type: 'number', min: 60, max: 86400, restart: false },
          { key: 'TTL_META', label: 'Meta', type: 'number', min: 60, max: 604800, restart: false },
          { key: 'TTL_WALLPAPERS', label: 'Wallpapers', type: 'number', min: 60, max: 604800, restart: false },
          { key: 'TTL_NOT_FOUND', label: 'Not found', type: 'number', min: 5, max: 3600, restart: false,
            help: 'Caching a miss stops one bad tag being asked upstream repeatedly.' },
        ],
      },
      {
        title: 'Limits and retention',
        settings: [
          { key: 'RATE_WINDOW_MS', label: 'Rate window (ms)', type: 'number',
            min: 1000, max: 3600000, restart: true },
          { key: 'RATE_MAX', label: 'Requests per window', type: 'number',
            min: 10, max: 100000, restart: true },
          { key: 'POSTGRES_RETENTION_DAYS', label: 'Meta retention (days)', type: 'number',
            min: 7, max: 3650, restart: false },
          { key: 'POSTGRES_BATTLE_RETENTION_DAYS', label: 'Battle retention (days)', type: 'number',
            min: 7, max: 730, restart: false,
            help: 'Battles are the bulk of the database. Six months is the default.' },
          { key: 'POSTGRES_DISK_BUDGET_GB', label: 'Disk budget (GB)', type: 'number',
            min: 1, max: 500, restart: false,
            help: 'Past this, old battles are pruned early to stay inside it.' },
        ],
      },
      {
        title: 'Diagnostics',
        settings: [
          { key: 'LOG_LEVEL', label: 'Log level', type: 'select',
            options: ['error', 'warn', 'info', 'debug'], restart: false },
        ],
      },
    ],
  },

  skincraft: {
    name: 'SkinCraft',
    groups: [
      {
        title: 'AI design',
        settings: [
          { key: 'AI_IMAGE_API_KEY', label: 'Image API key', type: 'secret', restart: false,
            help: 'Switches the AI designer on. Each generation is charged to this key.' },
          { key: 'AI_IMAGE_BASE_URL', label: 'Provider base URL', type: 'text', restart: false,
            help: 'Any OpenAI-compatible endpoint. Default https://api.openai.com/v1' },
          { key: 'AI_IMAGE_MODEL', label: 'Model', type: 'text', restart: false },
        ],
      },
      {
        title: 'Uploads',
        settings: [
          { key: 'MAX_UPLOAD_MB', label: 'Maximum upload (MB)', type: 'number',
            min: 1, max: 100, restart: true },
          { key: 'CORS_ORIGINS', label: 'Allowed origins', type: 'text', restart: true,
            help: 'Comma separated. The app fetches images cross-origin.' },
        ],
      },
      {
        title: 'App Store',
        settings: [
          { key: 'APPLE_TEAM_ID', label: 'Apple team id', type: 'text', restart: false },
          { key: 'IOS_BUNDLE_ID', label: 'iOS bundle id', type: 'text', restart: false },
        ],
      },
    ],
  },

  platform: {
    name: 'Platform config',
    groups: [
      {
        title: 'Client config',
        settings: [
          { key: 'CLIENT_CACHE_SECONDS', label: 'Config cache (seconds)', type: 'number',
            min: 0, max: 3600, restart: false,
            help: 'How long an app holds its config. Lower means an ads-off switch lands sooner.' },
          { key: 'TRACK_FETCHES', label: 'Count config fetches', type: 'boolean', restart: false },
        ],
      },
      {
        title: 'Limits',
        settings: [
          { key: 'RATE_WINDOW_MS', label: 'Rate window (ms)', type: 'number',
            min: 1000, max: 3600000, restart: true },
          { key: 'RATE_MAX', label: 'Requests per window', type: 'number',
            min: 10, max: 100000, restart: true },
          { key: 'LOG_LEVEL', label: 'Log level', type: 'select',
            options: ['error', 'warn', 'info', 'debug'], restart: false },
        ],
      },
    ],
  },
};

/** Every setting for a service, flattened, with its group title attached. */
export function settingsFor(service) {
  const entry = CATALOGUE[service];
  if (!entry) return [];

  return entry.groups.flatMap((g) =>
    g.settings.map((s) => ({ ...s, group: g.title })),
  );
}

export function findSetting(service, key) {
  return settingsFor(service).find((s) => s.key === key) ?? null;
}

export const serviceNames = () => Object.keys(CATALOGUE);

/**
 * Checks a submitted value against its declaration.
 *
 * Returns `{ ok, value }` with the value coerced to its real type, or
 * `{ ok: false, reason }`. Coercion matters: an HTML form submits "8" and a
 * service comparing it numerically would find "8" > 16 is false but "9" > 16
 * is true, string-wise.
 */
export function validateSetting(service, key, raw) {
  const spec = findSetting(service, key);
  if (!spec) return { ok: false, reason: `'${key}' is not a setting of ${service}.` };

  switch (spec.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: `${spec.label} must be a number.` };
      if (spec.min != null && n < spec.min) {
        return { ok: false, reason: `${spec.label} must be at least ${spec.min}.` };
      }
      if (spec.max != null && n > spec.max) {
        return { ok: false, reason: `${spec.label} must be at most ${spec.max}.` };
      }
      return { ok: true, value: n };
    }

    case 'boolean':
      return { ok: true, value: raw === true || raw === 'true' || raw === 'on' || raw === 1 };

    case 'select':
      if (!spec.options?.includes(String(raw))) {
        return { ok: false, reason: `${spec.label} must be one of: ${spec.options?.join(', ')}.` };
      }
      return { ok: true, value: String(raw) };

    case 'secret': {
      const s = String(raw ?? '');
      if (!s.trim()) return { ok: false, reason: `${spec.label} cannot be blank.` };
      return { ok: true, value: s.trim() };
    }

    default: {
      const s = String(raw ?? '').trim();
      if (s.length > 2000) return { ok: false, reason: `${spec.label} is too long.` };
      return { ok: true, value: s };
    }
  }
}
