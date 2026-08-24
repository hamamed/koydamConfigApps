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

// Every rectangle below was measured from Roblox's own template files, downloaded from
// https://create.roblox.com/docs/avatar/classic-clothing, by scanning them for the flat colour
// blocks. They are not derived or approximated, and they were verified by dressing a 3D rig in
// the labelled template and reading the letters off the render.
//
// Two things a reconstruction would not guess:
//   1. The torso sits at the TOP of the sheet and the limbs BELOW it.
//   2. Each group has its own horizontal face order — torso runs R·F·L·B, the right limb runs
//      L·B·R·F, the left limb runs F·L·B·R. No single unwrap function produces all three.
//
// The caps are consistent: `top` sits directly above the `front` face, `bottom` directly below.
// The shirt and pants templates share this layout exactly; only the printed labels differ.

const GROUPS = {
  torso: {
    top:    { left: 231, top: 8,   width: 128, height: 64 },
    right:  { left: 165, top: 74,  width: 64,  height: 128 },
    front:  { left: 231, top: 74,  width: 128, height: 128 },
    left:   { left: 361, top: 74,  width: 64,  height: 128 },
    back:   { left: 427, top: 74,  width: 128, height: 128 },
    bottom: { left: 231, top: 204, width: 128, height: 64 },
  },
  // The avatar's right arm or leg — bottom-left of the sheet.
  rightLimb: {
    top:    { left: 217, top: 289, width: 64, height: 64 },
    left:   { left: 19,  top: 355, width: 64, height: 128 },
    back:   { left: 85,  top: 355, width: 64, height: 128 },
    right:  { left: 151, top: 355, width: 64, height: 128 },
    front:  { left: 217, top: 355, width: 64, height: 128 },
    bottom: { left: 217, top: 485, width: 64, height: 64 },
  },
  // The avatar's left arm or leg — bottom-right of the sheet.
  leftLimb: {
    top:    { left: 308, top: 289, width: 64, height: 64 },
    front:  { left: 308, top: 355, width: 64, height: 128 },
    left:   { left: 374, top: 355, width: 64, height: 128 },
    back:   { left: 440, top: 355, width: 64, height: 128 },
    right:  { left: 506, top: 355, width: 64, height: 128 },
    bottom: { left: 308, top: 485, width: 64, height: 64 },
  },
};

/** Which groups each garment paints. */
export const LAYOUTS = {
  shirt: { torso: GROUPS.torso, rightArm: GROUPS.rightLimb, leftArm: GROUPS.leftLimb },
  tshirt: { torso: GROUPS.torso, rightArm: GROUPS.rightLimb, leftArm: GROUPS.leftLimb },
  // Pants paint the waistband as well as the legs — that's what the torso group is for here.
  pants: { torso: GROUPS.torso, rightLeg: GROUPS.rightLimb, leftLeg: GROUPS.leftLimb },
  // A sheet only carries two limb groups, so a full-body texture necessarily paints the arm and
  // the leg on each side from the same artwork.
  avatar: {
    torso: GROUPS.torso,
    rightArm: GROUPS.rightLimb,
    leftArm: GROUPS.leftLimb,
    rightLeg: GROUPS.rightLimb,
    leftLeg: GROUPS.leftLimb,
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
      return GROUPS.rightLimb.front;
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
