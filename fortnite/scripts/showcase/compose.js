import { FRAME } from './page.js';

/** Clip timing, in seconds. */
export const TIMING = {
  duration: 6,
  fps: 30,
  card: { start: 0, length: 0.45, rise: 28 },
  art: { start: 0.25, length: 0.5, rise: 36, push: 0.035 },
  info: { start: 0.6, length: 0.45, rise: 24 },
  fadeOut: 0.4,
};

const CANVAS = '0x07070C';

/**
 * How far a layer still has to travel at time t: `rise` at `start`, easing out
 * (cubic) to zero after `length`. Close to the app's settle spring without the
 * overshoot, which reads as a wobble when the whole frame moves.
 */
const settle = ({ start, length, rise }) =>
  `${rise}*pow(1-min(1,max(0,(t-${start})/${length})),3)`;

/**
 * The filter graph that stacks the four layers into a clip.
 *
 * Inputs, in order: page (the backdrop, static), card (glow, tier fill and
 * border), art (the render, cut to the hero) and info (chip, name, description
 * and facts). The card rises and fades in; the art follows it up, then pushes
 * in slowly about its own centre; the text arrives last; the whole frame fades
 * to the canvas colour at the end.
 *
 * @param {{ x: number, y: number, width: number, height: number }} hero where the art layer belongs
 */
export function composeFilter(hero) {
  const { duration, card, art, info, fadeOut } = TIMING;
  const centreX = hero.x + hero.width / 2;
  const centreY = hero.y + hero.height / 2;
  const zoom = `(1+${art.push}*t/${duration})`;

  return [
    '[0:v]format=rgba[page]',
    `[1:v]format=rgba,fade=t=in:st=${card.start}:d=${card.length}:alpha=1[card]`,
    `[2:v]format=rgba,scale=w='trunc(${hero.width}*${zoom}/2)*2':h=-2:eval=frame,` +
      `fade=t=in:st=${art.start}:d=${art.length}:alpha=1[art]`,
    `[3:v]format=rgba,fade=t=in:st=${info.start}:d=${info.length}:alpha=1[info]`,
    `[page][card]overlay=x=0:y='${settle(card)}':format=auto[withCard]`,
    `[withCard][art]overlay=x='${centreX}-w/2':y='${centreY}-h/2+${settle(card)}+${settle(art)}':format=auto[withArt]`,
    `[withArt][info]overlay=x=0:y='${settle(info)}':format=auto,` +
      `fade=t=out:st=${duration - fadeOut}:d=${fadeOut}:color=${CANVAS},` +
      `crop=${FRAME.width}:${FRAME.height}:0:0,format=yuv420p[out]`,
  ].join(';');
}

/** The card's border, in px, which footage placed inside the card must not cover. */
const CARD_BORDER = 4;
/** The card's corner radius at the frame size, less the border. */
const INNER_RADIUS = 51;

/** Where footage goes: the card's rectangle, inside its border. */
export function innerRect(hero) {
  return {
    x: hero.x + CARD_BORDER,
    y: hero.y + CARD_BORDER,
    width: hero.width - 2 * CARD_BORDER,
    height: hero.height - 2 * CARD_BORDER,
  };
}

/**
 * ffmpeg arguments that draw the card's rounded shape as a grey mask, once per
 * card size. Drawn with geq, which is slow per frame, so it is made as a still
 * and looped rather than computed for every frame of every clip.
 */
export function maskArgs({ width, height }, output) {
  const r = INNER_RADIUS;
  const outside = `pow(max(max(${r}-X,X-(${width - 1}-${r})),0),2)+pow(max(max(${r}-Y,Y-(${height - 1}-${r})),0),2)`;
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:d=1`,
    '-vf', `format=gray,geq=lum='if(lte(${outside},${r * r}),255,0)'`,
    '-frames:v', '1', output,
  ];
}

/**
 * ffmpeg arguments for a clip whose card holds cropped showcase footage.
 *
 * Inputs: page, card, the source video, the rounded mask, info. The footage is
 * cut from `crop` (a rectangle in the source, already shaped like the card),
 * scaled into the card, given the card's corners, and animated like a rendered
 * clip's artwork; the source's audio is dropped. `timing` is the part of the
 * source to use, and sets the clip's length.
 *
 * @param {{ start: number, duration: number }} timing seconds, from clipTiming()
 */
export function composeVideoArgs({ page, card, info, mask }, video, hero, crop, timing, output) {
  const { fps, fadeOut } = TIMING;
  const { start, duration } = timing;
  const inner = innerRect(hero);
  const still = (file) => ['-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', file];
  const cardRise = TIMING.card;
  const artRise = TIMING.art;

  const filter = [
    '[0:v]format=rgba[page]',
    `[1:v]format=rgba,fade=t=in:st=0:d=${cardRise.length}:alpha=1[card]`,
    `[2:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${inner.width}:${inner.height},fps=${fps},format=rgba[footage]`,
    '[3:v]format=gray[mask]',
    `[footage][mask]alphamerge,fade=t=in:st=${artRise.start}:d=${artRise.length}:alpha=1[art]`,
    `[4:v]format=rgba,fade=t=in:st=${TIMING.info.start}:d=${TIMING.info.length}:alpha=1[info]`,
    `[page][card]overlay=x=0:y='${settle(cardRise)}':format=auto[withCard]`,
    `[withCard][art]overlay=x=${inner.x}:y='${inner.y}+${settle(cardRise)}+${settle(artRise)}':format=auto[withArt]`,
    `[withArt][info]overlay=x=0:y='${settle(TIMING.info)}':format=auto,` +
      `fade=t=out:st=${duration - fadeOut}:d=${fadeOut}:color=${CANVAS},format=yuv420p[out]`,
  ].join(';');

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...still(page), ...still(card),
    '-ss', String(start), '-t', String(duration), '-i', video,
    ...still(mask), ...still(info),
    '-filter_complex', filter,
    '-map', '[out]', '-r', String(fps), '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-profile:v', 'high',
    '-x264-params', 'aq-mode=3', '-movflags', '+faststart', '-an', output,
  ];
}

/** ffmpeg arguments for one clip, given the four layer PNGs in stacking order. */
export function composeArgs({ page, card, art, info }, hero, output) {
  const { duration, fps } = TIMING;
  const still = (file) => ['-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', file];
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...still(page), ...still(card), ...still(art), ...still(info),
    '-filter_complex', composeFilter(hero),
    '-map', '[out]', '-r', String(fps), '-t', String(duration),
    // Dark gradients band badly at the usual settings; adaptive quantisation
    // spends bits on the flat areas that show it.
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high',
    '-x264-params', 'aq-mode=3', '-movflags', '+faststart', '-an', output,
  ];
}
