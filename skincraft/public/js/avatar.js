/*
 * The template, worn.
 *
 * A flat 585x559 sheet tells you almost nothing about whether a design works:
 * the question is always whether it lines up across the seams once it is on a
 * body, and that is not answerable by looking at the sheet. This paints it onto
 * an R6 avatar so the seams are visible before anyone uploads to Roblox.
 *
 * ## Why there is no 3D library here
 *
 * The projection is orthographic, and under a parallel projection a rectangle
 * maps to a parallelogram — never a trapezoid. A parallelogram is exactly what
 * `setTransform` draws, so each face is one `drawImage` through one affine
 * matrix, with no perspective divide and no splitting into triangles. That is
 * the whole renderer. A perspective camera would need per-triangle correction
 * and, at that point, a library.
 *
 * The cost is honest: no foreshortening. For a blocky avatar reviewed head-on
 * that is not a loss, and it buys exact texel alignment at the seams — which is
 * the thing being reviewed.
 *
 * ## The unwrap
 *
 * Face corners follow the layout documented in utils/template-layout.js: the
 * horizontal strip runs right, front, left, back as a continuous walk around
 * the part, with `top` folded up from the front edge and `bottom` folded down.
 * The avatar faces +z; its own right hand is at -x, which is the viewer's left.
 *
 * Check it with /admin/skins/ai/layout-proof.png as the texture: red must land
 * on the chest, blue on the back, green and yellow on the sides.
 */
(function (root) {
  'use strict';

  // R6 proportions in studs, matching AvatarRigKind.r6 in the iOS app so the
  // panel and the app show the same body rather than two interpretations of it.
  // The sheet is 64px to the stud, which is why the torso front rectangle is
  // 128x128 and a limb is 64x128.
  //
  // Two numbers are not the obvious ones. Shoulders sit at 1.55 rather than
  // 1.5: flush arms and torso are geometrically correct and read as a single
  // slab, and the 0.05 gap is what makes them look like arms. The head sits
  // 0.05 above the shoulders for the same reason — it reads as a neck without
  // modelling one.
  const SHOULDER_X = 1.55;
  const HIP_X = 0.5;
  const TORSO = [2, 2, 1];
  const HEAD = [1.6, 1.4, 1.6];

  // Origin at the hips, as in the app.
  const PARTS = [
    { name: 'head',     group: null,       size: HEAD,    at: [0, TORSO[1] + HEAD[1] / 2 + 0.05, 0], head: true },
    { name: 'torso',    group: 'torso',    size: TORSO,   at: [0, TORSO[1] / 2, 0] },
    { name: 'rightArm', group: 'rightArm', size: [1, 2, 1], at: [-SHOULDER_X, TORSO[1] - 1, 0] },
    { name: 'leftArm',  group: 'leftArm',  size: [1, 2, 1], at: [SHOULDER_X, TORSO[1] - 1, 0] },
    { name: 'rightLeg', group: 'rightLeg', size: [1, 2, 1], at: [-HIP_X, -1, 0] },
    { name: 'leftLeg',  group: 'leftLeg',  size: [1, 2, 1], at: [HIP_X, -1, 0] },
  ];

  // Feet at -2, top of head at 3.45. Centring on the midpoint keeps the body in
  // the frame instead of hanging off the bottom of it.
  const TOP = TORSO[1] + 0.05 + HEAD[1];
  const BOTTOM = -2;
  const HEIGHT = TOP - BOTTOM;
  const CENTRE_Y = (TOP + BOTTOM) / 2;

  /**
   * Corners per face as [origin, +u edge, +v edge], in half-extent units.
   *
   * u is the texture's left-to-right, v its top-to-bottom. Getting one of these
   * backwards mirrors that face's artwork, which on a symmetrical design is
   * invisible until someone wears it and the text on the back reads inside out.
   */
  const FACES = {
    front:  { n: [0, 0, 1],  o: [-1, 1, 1],   u: [1, 1, 1],   v: [-1, -1, 1] },
    back:   { n: [0, 0, -1], o: [1, 1, -1],   u: [-1, 1, -1],  v: [1, -1, -1] },
    right:  { n: [-1, 0, 0], o: [-1, 1, -1],  u: [-1, 1, 1],  v: [-1, -1, -1] },
    left:   { n: [1, 0, 0],  o: [1, 1, 1],    u: [1, 1, -1],   v: [1, -1, 1] },
    top:    { n: [0, 1, 0],  o: [-1, 1, -1],  u: [1, 1, -1],   v: [-1, 1, 1] },
    bottom: { n: [0, -1, 0], o: [-1, -1, 1],  u: [1, -1, 1],   v: [-1, -1, -1] },
  };

  // Matches FACE_SHADE on the server, so the preview agrees with the card
  // artwork the seeder derives rather than being a second opinion.
  const SHADE = { front: 1, left: 0.88, right: 0.88, back: 0.8, top: 1.1, bottom: 0.66 };

  const UNCLOTHED = '#d9c9a3';
  const HEAD_TONE = '#f2d68c';

  function rotate(point, yaw, pitch) {
    const [x, y, z] = point;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  }

  /**
   * Every visible face, in the order they must be drawn.
   *
   * Back-facing quads are dropped by the sign of the rotated normal's z, and
   * what is left is sorted far-to-near. Painter's algorithm is enough here
   * because the parts are convex boxes that do not interpenetrate — a depth
   * buffer would buy nothing.
   */
  function buildFaces(category, layouts, yaw, pitch) {
    const layout = layouts[category] || layouts.shirt || {};
    const out = [];

    for (const part of PARTS) {
      const [sx, sy, sz] = part.size;
      const half = [sx / 2, sy / 2, sz / 2];
      const group = part.group ? layout[part.group] : null;

      for (const [face, spec] of Object.entries(FACES)) {
        const normal = rotate(spec.n, yaw, pitch);
        if (normal[2] <= 0.0001) continue;

        const corner = (c) => rotate(
          [
            part.at[0] + c[0] * half[0],
            part.at[1] + c[1] * half[1] - CENTRE_Y,
            part.at[2] + c[2] * half[2],
          ],
          yaw,
          pitch,
        );

        const o = corner(spec.o);
        const u = corner(spec.u);
        const v = corner(spec.v);

        out.push({
          part: part.name,
          face,
          o, u, v,
          depth: (o[2] + u[2] + v[2]) / 3,
          rect: group ? group[face] : null,
          shade: SHADE[face] ?? 1,
          fill: part.head ? HEAD_TONE : UNCLOTHED,
          // The classic smile goes on one face only, and only when that face is
          // the one pointing at us.
          isHeadFront: Boolean(part.head) && face === 'front',
        });
      }
    }

    return out.sort((a, b) => a.depth - b.depth);
  }

  function render(canvas, texture, category, layouts, sheet, yaw, pitch) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fit the body's real height with a margin, rather than a number picked to
    // look right for one garment.
    const scale = (Math.min(width / 4.6, height / (HEIGHT + 1.1))) * dpr;
    const originX = (width * dpr) / 2;
    const originY = (height * dpr) / 2;

    const flat = (p) => [originX + p[0] * scale, originY - p[1] * scale];

    for (const f of buildFaces(category, layouts, yaw, pitch)) {
      const o = flat(f.o);
      const u = flat(f.u);
      const v = flat(f.v);

      if (f.rect && texture) {
        // Map the texture rectangle's unit square onto the projected
        // parallelogram. Exact, because a parallel projection cannot produce
        // anything a 2x3 matrix could not express.
        ctx.save();
        ctx.setTransform(
          (u[0] - o[0]) / f.rect.width, (u[1] - o[1]) / f.rect.width,
          (v[0] - o[0]) / f.rect.height, (v[1] - o[1]) / f.rect.height,
          o[0], o[1],
        );
        // A hair of overdraw: adjacent faces share an edge, and rounding on
        // each side of it leaves a visible hairline of background otherwise.
        ctx.drawImage(
          texture,
          f.rect.left, f.rect.top, f.rect.width, f.rect.height,
          -0.5, -0.5, f.rect.width + 1, f.rect.height + 1,
        );

        if (f.shade !== 1) {
          ctx.globalAlpha = Math.abs(1 - f.shade);
          ctx.fillStyle = f.shade < 1 ? '#000' : '#fff';
          ctx.fillRect(-0.5, -0.5, f.rect.width + 1, f.rect.height + 1);
        }
        ctx.restore();
      } else {
        // Skin, or a part this garment does not paint.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.moveTo(o[0], o[1]);
        ctx.lineTo(u[0], u[1]);
        ctx.lineTo(u[0] + v[0] - o[0], u[1] + v[1] - o[1]);
        ctx.lineTo(v[0], v[1]);
        ctx.closePath();
        ctx.fillStyle = f.fill;
        ctx.globalAlpha = f.shade > 1 ? 1 : f.shade;
        ctx.fill();
        ctx.globalAlpha = 1;

        // The classic face. Without it a bare head reads as a crate balanced on
        // the shoulders, and the whole thing stops looking like a character.
        if (f.isHeadFront) {
          ctx.save();
          // Unit square across the face, so the features are placed in
          // proportions rather than pixels and survive any tile size.
          ctx.setTransform(
            u[0] - o[0], u[1] - o[1],
            v[0] - o[0], v[1] - o[1],
            o[0], o[1],
          );
          ctx.fillStyle = '#2b2118';
          ctx.fillRect(0.27, 0.33, 0.11, 0.17);
          ctx.fillRect(0.62, 0.33, 0.11, 0.17);
          ctx.beginPath();
          ctx.lineWidth = 0.055;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#2b2118';
          ctx.arc(0.5, 0.5, 0.21, 0.16 * Math.PI, 0.84 * Math.PI);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  const Avatar = { PARTS, FACES, SHADE, rotate, buildFaces, render };
  root.SkinCraftAvatar = Avatar;

  if (typeof document === 'undefined') return;

  // ── Catalogue cards ─────────────────────────────────────────────────────
  //
  // Static, not interactive: two dozen avatars each running an animation frame
  // would spend the whole page's budget spinning thumbnails nobody is looking
  // at. Rendered once, at the angle that shows a front, a side and the top.
  //
  // Lazy, because each card needs the full template sheet rather than the small
  // derived preview. Off-screen cards never fetch one.
  const cardAngle = { yaw: 0.55, pitch: 0.1 };

  function paintCard(holder, layout) {
    let config;
    try {
      config = JSON.parse(holder.dataset.avatarCard);
    } catch {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'ad-skin-worn';
    const texture = new Image();

    texture.onload = () => {
      holder.appendChild(canvas);
      render(canvas, texture, config.category, layout.layouts, layout.size,
        cardAngle.yaw, cardAngle.pitch);
      // Only now: swapping first would flash an empty box on a slow template,
      // and leave a permanently blank card if the image never arrives.
      holder.classList.add('is-worn');
    };
    // No handler on error — the flat preview underneath is already the answer.
    texture.src = config.texture;
  }

  document.querySelectorAll('[data-avatar-layouts]').forEach((grid) => {
    let layout;
    try {
      layout = JSON.parse(grid.dataset.avatarLayouts);
    } catch {
      return;
    }

    const cards = grid.querySelectorAll('[data-avatar-card]');

    if (!('IntersectionObserver' in window)) {
      cards.forEach((holder) => paintCard(holder, layout));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        paintCard(entry.target, layout);
      }
    }, { rootMargin: '300px' });

    cards.forEach((holder) => observer.observe(holder));
  });

  document.querySelectorAll('[data-avatar]').forEach((canvas) => {
    const config = JSON.parse(canvas.dataset.avatar);
    const texture = new Image();

    let yaw = 0.5;
    // Positive pitch looks down at it. Negative showed the soles of the feet
    // and the underside of the torso, which is the one angle nobody reviews a
    // shirt from.
    let pitch = 0.12;
    let dragging = false;
    let idle = true;
    let last = 0;

    const paint = () => render(canvas, texture.complete ? texture : null,
      config.category, config.layouts, config.sheet, yaw, pitch);

    // Turns slowly on its own until touched, because the seam someone needs to
    // see is rarely the one facing them when the page loads.
    const spin = (now) => {
      if (idle) {
        yaw += (now - (last || now)) * 0.00035;
        paint();
      }
      last = now;
      window.requestAnimationFrame(spin);
    };

    texture.onload = paint;
    texture.onerror = paint;
    texture.src = config.texture;

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      idle = false;
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      yaw += event.movementX * 0.01;
      pitch = Math.max(-0.6, Math.min(0.6, pitch + event.movementY * 0.005));
      paint();
    });

    const release = () => { dragging = false; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    window.addEventListener('resize', paint);
    window.requestAnimationFrame(spin);
    paint();
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
