import { Router } from 'express';

import { config } from '../config.js';
import { cached, cacheGet } from '../cache/store.js';
import { supercell } from '../supercell/client.js';
import { allBrawlerMeta, getBrawlerMeta } from '../transform/brawler_meta.js';
import { asyncRoute, BadRequestError } from '../middleware/errors.js';
import { fetchMaps, fetchGameModes, indexMapsById } from '../transform/game_catalog.js';
import { log } from '../log.js';
import { brawlerHistory, historyStats } from '../crawler/meta_history.js';
import { recordRotation } from '../db/analytics_repo.js';

export const catalogRouter = Router();

/**
 * GET /brawlers — the codex.
 *
 * Merges the official gadget/star-power lists with community metadata (rarity,
 * class, hypercharge, portraits). Official data wins on anything both provide,
 * since it's authoritative for what actually exists in the game.
 */
catalogRouter.get(
  '/brawlers',
  asyncRoute(async (req, res) => {
    const { data, cached: hit } = await cached(
      'brawlers:all',
      config.ttl.brawlers,
      async () => {
        const official = await supercell.brawlers().catch(() => ({ items: [] }));
        const officialById = new Map(
          (official.items ?? []).map((b) => [Number(b.id), b]),
        );

        // Union of both sources, so a brawler present in only one still appears.
        const ids = new Set([
          ...officialById.keys(),
          ...allBrawlerMeta().map((b) => Number(b.id)),
        ]);

        const items = [...ids]
          .map((id) => {
            const meta = getBrawlerMeta(id);
            const off = officialById.get(id);
            if (!meta && !off) return null;

            const gadgets = mergeItems(off?.gadgets, meta?.gadgets);
            const starPowers = mergeItems(off?.starPowers, meta?.starPowers);

            return {
              id,
              name: off?.name ?? meta?.name ?? 'Unknown',
              rarity: meta?.rarity ?? 'Common',
              class: meta?.class ?? 'Damage Dealer',
              description: meta?.description ?? null,
              portraitUrl: meta?.portraitUrl ?? null,

              gadgets,
              starPowers,
              gadgetsTotal: gadgets.length,
              starPowersTotal: starPowers.length,

              // Boolean only. No free source publishes hypercharge *detail*
              // (name/description/icon), so there is deliberately no
              // `hypercharge` object here — an always-null field would just
              // invite the client to render an empty section.
              hasHypercharge: meta?.hasHypercharge ?? false,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.id - b.id);

        return { count: items.length, items };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);

/**
 * GET /events/rotation — the live map rotation, with artwork.
 *
 * Supercell returns only a map *name* and a mode string per slot. The map
 * catalogue is joined in by id (both live in the `15xxxxxx` namespace) so each
 * slot carries its render and the mode's brand colour.
 */
catalogRouter.get(
  '/events/rotation',
  asyncRoute(async (req, res) => {
    const { data, cached: hit } = await cached(
      'events:rotation',
      config.ttl.events,
      async () => {
        // The map join must never take the rotation down with it — that data is
        // useful without artwork, so a failed catalogue fetch degrades to an
        // empty index rather than an error.
        const [raw, mapCatalogue] = await Promise.all([
          supercell.events(),
          cached('catalog:maps', config.ttl.brawlers, fetchMaps)
            .then((r) => r.data)
            .catch((err) => {
              log.warn('Map catalogue unavailable; serving events without art', {
                error: err.message,
              });
              return { items: [] };
            }),
        ]);

        const mapsById = indexMapsById(mapCatalogue);
        const items = Array.isArray(raw) ? raw : (raw.items ?? []);

        // Fire-and-forget: the rotation is what the caller asked for, and a
        // failed history write must not cost them the response. Inside the
        // cache factory on purpose, so it runs once per TTL rather than once
        // per request.
        recordRotation(items).catch((err) =>
          log.warn('Failed to record map rotation', { error: err.message }),
        );

        return {
          items: items.map((e) => {
            const id = Number(e.event?.id ?? 0);
            const mapMeta = mapsById.get(id);

            return {
              startTime: e.startTime ?? null,
              endTime: e.endTime ?? null,
              slotId: Number(e.slotId ?? 0),
              event: {
                id,
                mode: e.event?.mode ?? 'unknown',
                map: e.event?.map ?? mapMeta?.name ?? null,
                imageUrl: mapMeta?.imageUrl ?? null,
                environment: mapMeta?.environment ?? null,
                modeColor: mapMeta?.mode?.color ?? null,
                /** Bucket key used by /meta/map/:mapId — see meta_crawler.js. */
                metaKey: slug(`${e.event?.mode ?? ''}:${e.event?.map ?? ''}`),
              },
            };
          }),
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);

/** GET /maps — every currently-playable map, with artwork. */
catalogRouter.get(
  '/maps',
  asyncRoute(async (req, res) => {
    const { data, cached: hit } = await cached(
      'catalog:maps',
      config.ttl.brawlers,
      fetchMaps,
    );

    // ?mode=gemGrab narrows the list server-side so the client doesn't download
    // 404 entries to show 24.
    const mode = req.query.mode ? slug(String(req.query.mode)) : null;
    if (mode) {
      const items = data.items.filter(
        (m) => slug(m.mode.key ?? '') === mode || slug(m.mode.name) === mode,
      );
      res.set('X-Cache', hit ? 'HIT' : 'MISS');
      return res.json({ count: items.length, items });
    }

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    return res.json(data);
  }),
);

/** GET /gamemodes — active modes with rules and brand colours. */
catalogRouter.get(
  '/gamemodes',
  asyncRoute(async (req, res) => {
    const { data, cached: hit } = await cached(
      'catalog:gamemodes',
      config.ttl.brawlers,
      fetchGameModes,
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);

/**
 * GET /meta/tierlist — the crawler's output.
 *
 * Read-only: this endpoint never triggers a crawl. A request that kicked off 200
 * upstream calls would let one client stall (or hammer) the whole service. The
 * scheduler owns crawling; this just serves the last result.
 */
catalogRouter.get(
  '/meta/tierlist',
  asyncRoute(async (req, res) => {
    const payload = await cacheGet('meta:tierlist');

    if (!payload) {
      return res.status(503).json({
        error: 'meta_not_ready',
        message:
          'The tier list has not been built yet. First crawl runs shortly after boot.',
      });
    }

    const mode = req.query.mode ? slug(req.query.mode) : null;
    if (mode) {
      const bucket = payload.modes?.[mode];
      if (!bucket) {
        return res.status(404).json({
          error: 'mode_not_found',
          message: `No meta data for mode "${req.query.mode}".`,
          available: Object.keys(payload.modes ?? {}),
        });
      }
      return res.json({
        generatedAt: payload.generatedAt,
        sample: payload.sample,
        ...bucket,
      });
    }

    return res.json(payload);
  }),
);

/**
 * GET /meta/history/:brawlerId?mode=gemgrab — tier movement over time.
 *
 * Only meaningful once a few crawls have accumulated; returns an empty series
 * rather than an error before then.
 */
catalogRouter.get(
  '/meta/history/:brawlerId',
  asyncRoute(async (req, res) => {
    const id = Number.parseInt(req.params.brawlerId, 10);
    if (Number.isNaN(id)) throw new BadRequestError('Brawler id must be numeric.');

    const mode = slug(String(req.query.mode ?? 'gemgrab'));
    const series = await brawlerHistory(id, mode);

    res.json({ brawlerId: id, mode, points: series.length, series });
  }),
);

/** GET /meta/history — how much history has accumulated. */
catalogRouter.get(
  '/meta/history',
  asyncRoute(async (req, res) => res.json(await historyStats())),
);

/** GET /meta/map/:mapId — one map's tier list. `mapId` is a `mode:map` slug. */
catalogRouter.get(
  '/meta/map/:mapId',
  asyncRoute(async (req, res) => {
    const payload = await cacheGet('meta:tierlist');

    if (!payload) {
      return res.status(503).json({
        error: 'meta_not_ready',
        message: 'The tier list has not been built yet.',
      });
    }

    const id = slug(req.params.mapId);
    const bucket = payload.maps?.[id];

    if (!bucket) {
      return res.status(404).json({
        error: 'map_not_found',
        message: `No meta data for map "${req.params.mapId}". It may be out of rotation or below the sample threshold.`,
        available: Object.keys(payload.maps ?? {}).slice(0, 40),
      });
    }

    return res.json({
      generatedAt: payload.generatedAt,
      sample: payload.sample,
      ...bucket,
    });
  }),
);

/**
 * Merges an official item list with the community one, matched by id.
 *
 * The official API is authoritative for *which* gadgets and star powers exist,
 * but it only sends `{id, name}` — no descriptions, no icons. The community
 * source has both. Preferring one wholesale loses something either way, so the
 * official list drives membership and community data fills in the detail.
 *
 * Without this the Codex is just a list of names: before the merge only 1 of
 * 107 brawlers had any gadget description.
 */
function mergeItems(official, community) {
  const communityById = new Map(
    (community ?? []).map((i) => [Number(i.id), i]),
  );

  if (Array.isArray(official) && official.length > 0) {
    return official.map((item) => {
      const extra = communityById.get(Number(item.id));
      return {
        id: Number(item.id),
        // Official names are SHOUTY ("FAST FORWARD"); the community ones are
        // title case and read better in a detail sheet.
        name: extra?.name ?? item.name ?? '',
        description: extra?.description ?? null,
        imageUrl: extra?.imageUrl ?? null,
      };
    });
  }

  // No official list (brand-new brawler, or /brawlers failed) — use community.
  return (community ?? []).map((i) => ({
    id: Number(i.id),
    name: i.name ?? '',
    description: i.description ?? null,
    imageUrl: i.imageUrl ?? null,
  }));
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, '-')
    .replace(/^-|-$/g, '');
