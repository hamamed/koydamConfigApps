/**
 * The ffmpeg arguments that turn stills or footage into a showcase clip.
 *
 * A clip is only what sits inside the app's detail box: no frame, border or
 * text, and no fades, so it loops like a GIF and fills whatever box the app or
 * the panel draws around it. Both are 3:4, so a clip is too.
 */

export const CLIP_FRAME = Object.freeze({ width: 720, height: 960 });

const FPS = 30;

/** How a rendered clip moves: a slow zoom in and back out over its length. */
const RENDERED = Object.freeze({ duration: 6, push: 0.04 });

// Dark gradients band badly at the usual settings; adaptive quantisation
// spends bits on the flat areas that show it. The clips have no sound.
const ENCODE = [
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-x264-params', 'aq-mode=3', '-movflags', '+faststart', '-an',
];

/**
 * A clip from the tier backdrop and the artwork, rendered as two stills.
 *
 * The artwork zooms by a cosine over the clip's length — in, then back out —
 * so the last frame is the first and the loop has no jump.
 *
 * @param {{ page: string, art: string }} files backdrop, and artwork cut to its box
 * @param {{ x: number, y: number, width: number, height: number }} rect where the artwork box sits
 */
export function renderedClipArgs({ page, art }, rect, output) {
  const { duration, push } = RENDERED;
  const zoom = `(1+${push}*(1-cos(2*PI*t/${duration}))/2)`;
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  const still = (file) => ['-loop', '1', '-framerate', String(FPS), '-t', String(duration), '-i', file];

  const filter = [
    '[0:v]format=rgba[page]',
    `[1:v]format=rgba,scale=w='trunc(${rect.width}*${zoom}/2)*2':h=-2:eval=frame[art]`,
    `[page][art]overlay=x='${centreX}-w/2':y='${centreY}-h/2':format=auto,format=yuv420p[out]`,
  ].join(';');

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...still(page), ...still(art),
    '-filter_complex', filter,
    '-map', '[out]', '-r', String(FPS), '-t', String(duration),
    ...ENCODE, output,
  ];
}

/**
 * A clip cut from showcase footage: the crop window, scaled to the frame, for
 * the seconds `timing` chooses.
 *
 * @param {{ x: number, y: number, width: number, height: number }} crop a 3:4 window in the source
 * @param {{ start: number, duration: number }} timing seconds, from clipTiming()
 */
export function footageClipArgs(video, crop, timing, output) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(timing.start), '-t', String(timing.duration), '-i', video,
    '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${CLIP_FRAME.width}:${CLIP_FRAME.height},fps=${FPS},format=yuv420p`,
    '-r', String(FPS),
    ...ENCODE, output,
  ];
}
