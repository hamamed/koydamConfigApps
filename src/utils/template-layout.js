/**
 * The R6 clothing-template unwrap — one definition, used everywhere.
 *
 * These coordinates were duplicated: the seeder had its own `unwrap()` and the image service had
 * a hardcoded `HERO_REGIONS` table. Two copies of the same geometry is how a preview crop quietly
 * stops matching what the 3D renderer paints. Now the seeder, the preview deriver and the browser
 * designer all read this file (the designer gets it as JSON, injected into the page).
 *
 * It mirrors `ClothingTemplateLayout` in the iOS app: 1 stud = 64px on a 585×559 sheet, limb
 * groups at the top, torso centred below.
 */

export const TEMPLATE_SIZE = { width: 585, height: 559 };

const STUD = 64;

/**
 * The six faces of one box, laid out flat.
 *
 * ```
 *          ┌──────┐
 *          │ top  │
 *   ┌──────┼──────┼──────┬──────┐
 *   │ left │front │right │ back │
 *   └──────┼──────┼──────┴──────┘
 *          │bottom│
 *          └──────┘
 * ```
 */
function unwrap(originX, originY, faceWidth, depth, height) {
  const rowY = originY + depth;
  const frontX = originX + depth;

  return {
    left: { left: originX, top: rowY, width: depth, height },
    front: { left: frontX, top: rowY, width: faceWidth, height },
    right: { left: frontX + faceWidth, top: rowY, width: depth, height },
    back: { left: frontX + faceWidth + depth, top: rowY, width: faceWidth, height },
    top: { left: frontX, top: originY, width: faceWidth, height: depth },
    bottom: { left: frontX, top: rowY + height, width: faceWidth, height: depth },
  };
}

/** The three groups a template contains. Limbs at the top, torso centred below. */
const GROUPS = {
  leadingLimb: unwrap(2, 2, STUD, STUD, STUD * 2),
  trailingLimb: unwrap(327, 2, STUD, STUD, STUD * 2),
  torso: unwrap(100, 290, STUD * 2, STUD, STUD * 2),
};

/** Which groups each garment paints. */
export const LAYOUTS = {
  shirt: { torso: GROUPS.torso, rightArm: GROUPS.leadingLimb, leftArm: GROUPS.trailingLimb },
  tshirt: { torso: GROUPS.torso, rightArm: GROUPS.leadingLimb, leftArm: GROUPS.trailingLimb },
  pants: { rightLeg: GROUPS.leadingLimb, leftLeg: GROUPS.trailingLimb },
  avatar: {
    torso: GROUPS.torso,
    rightArm: GROUPS.leadingLimb,
    leftArm: GROUPS.trailingLimb,
    rightLeg: GROUPS.leadingLimb,
    leftLeg: GROUPS.trailingLimb,
  },
};

/** Per-face shading, so a flat colour reads as fabric rather than as a decal once it's worn. */
export const FACE_SHADE = {
  front: 1.0,
  left: 0.88,
  right: 0.88,
  back: 0.8,
  top: 1.1,
  bottom: 0.66,
};

/** Every paintable rectangle for a garment, flattened. */
export function facesFor(category) {
  const layout = LAYOUTS[category] || LAYOUTS.shirt;
  const faces = [];

  for (const [part, group] of Object.entries(layout)) {
    for (const [face, rect] of Object.entries(group)) {
      faces.push({ part, face, rect, shade: FACE_SHADE[face] ?? 1 });
    }
  }
  return faces;
}

/**
 * The region that best represents a garment — used for the derived card preview and as the
 * default drop target in the designer.
 */
export function heroRegion(category) {
  switch (category) {
    case 'pants':
      return GROUPS.leadingLimb.front;
    default:
      return GROUPS.torso.front;
  }
}

/** Faces a designer should be able to drop stickers on, in a sensible order. */
export function decalFaces(category) {
  const named = {
    shirt: [
      ['torso', 'front', 'Chest'],
      ['torso', 'back', 'Back'],
      ['leftArm', 'front', 'Left arm'],
      ['rightArm', 'front', 'Right arm'],
    ],
    pants: [
      ['leftLeg', 'front', 'Left leg'],
      ['rightLeg', 'front', 'Right leg'],
    ],
  };
  const list = category === 'pants' ? named.pants : named.shirt;

  return list
    .map(([part, face, label]) => {
      const rect = LAYOUTS[category]?.[part]?.[face];
      return rect ? { part, face, label, rect } : null;
    })
    .filter(Boolean);
}
