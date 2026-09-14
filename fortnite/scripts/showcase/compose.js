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
