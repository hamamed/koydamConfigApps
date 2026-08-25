/*
 * Browser-side skin designer.
 *
 * Composition happens here, not on the server, for one decisive reason: **emoji**. Rendering them
 * server-side means librsvg needs a colour emoji font installed, which a bare Ubuntu VPS doesn't
 * have — every sticker would come out as a tofu box. The browser already has the fonts, so it
 * draws the 585×559 canvas and uploads the finished PNG through the same endpoint a manual upload
 * uses. That means preview derivation, colour extraction and validation all happen exactly as they
 * do for any other skin, with no second code path to keep in step.
 */

(function () {
  'use strict';

  const root = document.getElementById('scDesigner');
  if (!root) return;

  const LAYOUT = JSON.parse(document.getElementById('scLayout').textContent);
  const canvas = document.getElementById('scCanvas');
  const ctx = canvas.getContext('2d');

  const state = {
    category: 'shirt',
    base: '#5A4BE8',
    accent: '#B6F36B',
    pattern: 'stripes',
    patternScale: 1,
    decals: [],
    selectedId: null,
    photo: null,          // HTMLImageElement, used as a chest graphic
  };

  let nextId = 1;

  // ── Geometry ───────────────────────────────────────────────────────────────

  function faces() {
    const layout = LAYOUT.layouts[state.category] || LAYOUT.layouts.shirt;
    const out = [];
    for (const [part, group] of Object.entries(layout)) {
      for (const [face, rect] of Object.entries(group)) {
        out.push({ part, face, rect, shade: LAYOUT.shade[face] ?? 1 });
      }
    }
    return out;
  }

  /** The face rectangle containing a point, so a dropped sticker clips to what it landed on. */
  function faceAt(x, y) {
    return faces().find((f) =>
      x >= f.rect.left && x <= f.rect.left + f.rect.width &&
      y >= f.rect.top && y <= f.rect.top + f.rect.height
    ) || null;
  }

  // ── Colour helpers ─────────────────────────────────────────────────────────

  function shade(hex, factor) {
    const { r, g, b } = hexToRgb(hex);
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
    return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
  }

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const f of faces()) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(f.rect.left, f.rect.top, f.rect.width, f.rect.height);
      ctx.clip();

      ctx.fillStyle = shade(state.base, f.shade);
      ctx.fillRect(f.rect.left, f.rect.top, f.rect.width, f.rect.height);

      drawPattern(f);
      ctx.restore();
    }

    for (const decal of state.decals) drawDecal(decal);

    drawGuides();
  }

  function drawPattern(f) {
    if (state.pattern === 'none') return;

    const { rect } = f;
    const unit = Math.max(6, Math.min(rect.width, rect.height) * 0.18 * state.patternScale);
    ctx.fillStyle = shade(state.accent, f.shade);

    switch (state.pattern) {
      case 'stripes':
        for (let x = rect.left; x < rect.left + rect.width; x += unit) {
          ctx.fillRect(x, rect.top, unit / 2, rect.height);
        }
        break;

      case 'checks': {
        let row = 0;
        for (let y = rect.top; y < rect.top + rect.height; y += unit, row += 1) {
          let column = 0;
          for (let x = rect.left; x < rect.left + rect.width; x += unit, column += 1) {
            if ((row + column) % 2 === 0) ctx.fillRect(x, y, unit, unit);
          }
        }
        break;
      }

      case 'dots': {
        let row = 0;
        for (let y = rect.top + unit / 2; y < rect.top + rect.height; y += unit, row += 1) {
          const offset = row % 2 === 0 ? unit / 2 : unit;
          for (let x = rect.left + offset; x < rect.left + rect.width; x += unit) {
            ctx.beginPath();
            ctx.arc(x, y, unit * 0.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }

      case 'diagonal':
        ctx.save();
        ctx.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
        ctx.rotate(Math.PI / 4);
        {
          const reach = Math.max(rect.width, rect.height) * 1.6;
          for (let x = -reach; x < reach; x += unit) ctx.fillRect(x, -reach, unit / 2, reach * 2);
        }
        ctx.restore();
        break;

      case 'camo':
        // Seeded by the region so the blobs don't reshuffle on every redraw — a camo that
        // shimmers while you drag a slider looks broken.
        for (let i = 0; i < 14; i += 1) {
          const a = pseudoRandom(rect.left + i * 3);
          const b = pseudoRandom(rect.top + i * 7);
          const c = pseudoRandom(i * 13 + rect.width);
          ctx.beginPath();
          ctx.ellipse(
            rect.left + a * rect.width, rect.top + b * rect.height,
            unit * (0.55 + c * 0.5), unit * (0.45 + c * 0.4),
            0, 0, Math.PI * 2
          );
          ctx.fill();
        }
        break;

      case 'gradient': {
        const gradient = ctx.createLinearGradient(0, rect.top, 0, rect.top + rect.height);
        const { r, g, b } = hexToRgb(state.accent);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 1)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
        break;
      }
    }
  }

  function pseudoRandom(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawDecal(decal) {
    const face = faceAt(decal.x, decal.y);

    ctx.save();
    if (face) {
      // Clipped to whatever it was dropped on, so a sticker can't bleed onto a neighbouring
      // region of the sheet and appear on the wrong body part.
      ctx.beginPath();
      ctx.rect(face.rect.left, face.rect.top, face.rect.width, face.rect.height);
      ctx.clip();
    }
    ctx.translate(decal.x, decal.y);
    ctx.rotate(decal.rotation);

    if (decal.type === 'emoji') {
      ctx.font = `${decal.size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(decal.value, 0, 0);
    } else if (decal.type === 'photo' && state.photo) {
      const ratio = state.photo.width / state.photo.height;
      const width = decal.size * (ratio >= 1 ? 1 : ratio);
      const height = decal.size * (ratio >= 1 ? 1 / ratio : 1);
      ctx.drawImage(state.photo, -width / 2, -height / 2, width, height);
    } else if (decal.type === 'shape') {
      ctx.fillStyle = decal.color;
      ctx.strokeStyle = decal.color;
      ctx.lineWidth = decal.size * 0.12;
      ctx.lineJoin = 'round';
      drawShape(decal.value, decal.size);
    }

    ctx.restore();
  }

  function drawShape(kind, size) {
    const r = size / 2;
    ctx.beginPath();

    switch (kind) {
      case 'star': {
        for (let i = 0; i < 10; i += 1) {
          const radius = i % 2 === 0 ? r : r * 0.45;
          const angle = (Math.PI / 5) * i - Math.PI / 2;
          const fn = i === 0 ? 'moveTo' : 'lineTo';
          ctx[fn](Math.cos(angle) * radius, Math.sin(angle) * radius);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'heart':
        ctx.moveTo(0, r * 0.75);
        ctx.bezierCurveTo(-r * 1.6, -r * 0.3, -r * 0.6, -r * 1.2, 0, -r * 0.4);
        ctx.bezierCurveTo(r * 0.6, -r * 1.2, r * 1.6, -r * 0.3, 0, r * 0.75);
        ctx.fill();
        break;
      case 'circle':
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'ring':
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'triangle':
        ctx.moveTo(0, -r);
        ctx.lineTo(r, r * 0.8);
        ctx.lineTo(-r, r * 0.8);
        ctx.closePath();
        ctx.fill();
        break;
      case 'bolt':
        ctx.moveTo(r * 0.15, -r);
        ctx.lineTo(-r * 0.6, r * 0.15);
        ctx.lineTo(-r * 0.05, r * 0.15);
        ctx.lineTo(-r * 0.2, r);
        ctx.lineTo(r * 0.6, -r * 0.2);
        ctx.lineTo(r * 0.02, -r * 0.2);
        ctx.closePath();
        ctx.fill();
        break;
      case 'diamond':
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.75, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r * 0.75, 0);
        ctx.closePath();
        ctx.fill();
        break;
      default:
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
    }
  }

  /** Face outlines and the selection box — drawn on the canvas but never exported. */
  function drawGuides() {
    if (!root.dataset.guides) return;

    ctx.save();
    // Drawn twice — a dark line under a light dashed one. A single hairline disappears against a
    // busy pattern, which is exactly when you need to see where a face ends.
    for (const f of faces()) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(f.rect.left + 1, f.rect.top + 1, f.rect.width - 2, f.rect.height - 2);

      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.strokeRect(f.rect.left + 1, f.rect.top + 1, f.rect.width - 2, f.rect.height - 2);
    }

    const selected = state.decals.find((d) => d.id === state.selectedId);
    if (selected) {
      ctx.setLineDash([]);
      ctx.strokeStyle = '#2DE2E6';
      ctx.lineWidth = 2;
      const half = selected.size * 0.66;
      ctx.strokeRect(selected.x - half, selected.y - half, half * 2, half * 2);
    }
    ctx.restore();
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Re-renders without guides, so the published PNG is clean. */
  function exportBlob() {
    const guides = root.dataset.guides;
    delete root.dataset.guides;
    render();

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (guides) root.dataset.guides = guides;
        render();
        resolve(blob);
      }, 'image/png');
    });
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  function canvasPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    const source = event.touches ? event.touches[0] : event;
    return {
      x: ((source.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((source.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }

  function decalAt(point) {
    // Reverse order so the topmost sticker wins, matching what the user sees.
    for (let i = state.decals.length - 1; i >= 0; i -= 1) {
      const decal = state.decals[i];
      const half = decal.size * 0.66;
      if (Math.abs(point.x - decal.x) <= half && Math.abs(point.y - decal.y) <= half) return decal;
    }
    return null;
  }

  let dragging = null;
  let dragOffset = { x: 0, y: 0 };

  function onPointerDown(event) {
    const point = canvasPoint(event);
    const decal = decalAt(point);

    state.selectedId = decal ? decal.id : null;
    if (decal) {
      dragging = decal;
      dragOffset = { x: point.x - decal.x, y: point.y - decal.y };
      event.preventDefault();
    }
    syncSelectionControls();
    render();
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const point = canvasPoint(event);
    dragging.x = point.x - dragOffset.x;
    dragging.y = point.y - dragOffset.y;
    event.preventDefault();
    render();
  }

  function onPointerUp() {
    dragging = null;
  }

  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', onPointerMove, { passive: false });
  canvas.addEventListener('touchend', onPointerUp);

  // ── Controls ───────────────────────────────────────────────────────────────

  function addDecal(type, value, color) {
    const hero = LAYOUT.hero[state.category] || LAYOUT.hero.shirt;
    const decal = {
      id: nextId++,
      type,
      value,
      color: color || document.getElementById('scShapeColor').value,
      x: hero.left + hero.width / 2,
      y: hero.top + hero.height / 2,
      size: Math.min(hero.width, hero.height) * 0.45,
      rotation: 0,
    };
    state.decals.push(decal);
    state.selectedId = decal.id;
    syncSelectionControls();
    render();
  }

  function selected() {
    return state.decals.find((d) => d.id === state.selectedId) || null;
  }

  function syncSelectionControls() {
    const panel = document.getElementById('scSelection');
    const decal = selected();
    panel.style.display = decal ? '' : 'none';
    if (!decal) return;

    document.getElementById('scDecalSize').value = decal.size;
    document.getElementById('scDecalRotation').value = decal.rotation;
  }

  function bind(id, event, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener(event, handler);
  }

  bind('scCategory', 'change', (e) => {
    state.category = e.target.value;
    render();
  });
  bind('scBase', 'input', (e) => { state.base = e.target.value; render(); });
  bind('scAccent', 'input', (e) => { state.accent = e.target.value; render(); });
  bind('scPattern', 'change', (e) => { state.pattern = e.target.value; render(); });
  bind('scPatternScale', 'input', (e) => { state.patternScale = Number(e.target.value); render(); });

  bind('scDecalSize', 'input', (e) => {
    const decal = selected();
    if (!decal) return;
    decal.size = Number(e.target.value);
    render();
  });
  bind('scDecalRotation', 'input', (e) => {
    const decal = selected();
    if (!decal) return;
    decal.rotation = Number(e.target.value);
    render();
  });
  bind('scDecalDelete', 'click', () => {
    state.decals = state.decals.filter((d) => d.id !== state.selectedId);
    state.selectedId = null;
    syncSelectionControls();
    render();
  });
  bind('scDecalFront', 'click', () => {
    const decal = selected();
    if (!decal) return;
    state.decals = state.decals.filter((d) => d.id !== decal.id).concat(decal);
    render();
  });

  bind('scGuides', 'change', (e) => {
    if (e.target.checked) root.dataset.guides = '1';
    else delete root.dataset.guides;
    render();
  });

  document.querySelectorAll('[data-emoji]').forEach((button) => {
    button.addEventListener('click', () => addDecal('emoji', button.dataset.emoji));
  });
  document.querySelectorAll('[data-shape]').forEach((button) => {
    button.addEventListener('click', () => addDecal('shape', button.dataset.shape));
  });

  // ── Photo import ───────────────────────────────────────────────────────────

  bind('scPhoto', 'change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const image = new Image();
    image.onload = () => {
      state.photo = image;

      const palette = extractPalette(image);
      if (palette.length >= 1) {
        state.base = palette[0];
        document.getElementById('scBase').value = palette[0];
      }
      if (palette.length >= 2) {
        state.accent = palette[1];
        document.getElementById('scAccent').value = palette[1];
      }
      renderPaletteChips(palette);

      document.getElementById('scPhotoActions').style.display = '';
      render();
    };
    image.src = URL.createObjectURL(file);
  });

  bind('scPhotoAsGraphic', 'click', () => {
    if (!state.photo) return;
    addDecal('photo', 'photo');
  });

  /**
   * Dominant colours from an image.
   *
   * Quantises to a coarse grid and counts, rather than averaging: an average turns a vivid photo
   * into mud, whereas the most *frequent* bucket is usually the colour a person would name if you
   * asked them what the picture is. Near-greys are skipped so a photo shot against a white wall
   * doesn't hand back white and grey as its palette.
   */
  function extractPalette(image) {
    const size = 64;
    const scratch = document.createElement('canvas');
    scratch.width = size;
    scratch.height = size;

    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    scratchCtx.drawImage(image, 0, 0, size, size);

    const { data } = scratchCtx.getImageData(0, 0, size, size);
    const buckets = new Map();

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;

      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;

      // Skip near-greys and near-blacks; they dominate photographs and say nothing about colour.
      if (saturation < 0.18 || max < 40) continue;

      const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
      const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      entry.count += 1;
      entry.r += r; entry.g += g; entry.b += b;
      buckets.set(key, entry);
    }

    return [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((entry) => rgbToHex(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count));
  }

  function renderPaletteChips(palette) {
    const container = document.getElementById('scPalette');
    container.innerHTML = '';

    palette.forEach((hex) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ad-swatch';
      chip.style.background = hex;
      chip.title = `Use ${hex} as the base colour`;
      chip.addEventListener('click', () => {
        state.base = hex;
        document.getElementById('scBase').value = hex;
        render();
      });
      container.appendChild(chip);
    });
  }

  // ── Publish ────────────────────────────────────────────────────────────────

  bind('scPublish', 'submit', async (event) => {
    event.preventDefault();

    const form = event.target;
    const button = document.getElementById('scPublishButton');
    const status = document.getElementById('scPublishStatus');

    if (!form.title.value.trim()) {
      status.textContent = 'Give it a title first.';
      return;
    }

    button.disabled = true;
    status.textContent = 'Rendering and uploading…';

    try {
      const blob = await exportBlob();
      const payload = new FormData(form);
      // Goes through the same endpoint a manual upload uses, so the derived preview, dominant
      // colour and validation all happen exactly as they do for any other skin.
      payload.set('template', blob, 'designed.png');
      payload.set('category', state.category);

      const response = await fetch('/admin/skins', { method: 'POST', body: payload });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);

      window.location.href = response.redirected ? response.url : '/admin/skins';
    } catch (error) {
      status.textContent = error.message || 'Something went wrong.';
      button.disabled = false;
    }
  });

  bind('scDownload', 'click', async () => {
    const blob = await exportBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skincraft-template.png';
    link.click();
    URL.revokeObjectURL(url);
  });

  // ── Go ─────────────────────────────────────────────────────────────────────

  root.dataset.guides = '1';
  render();
  syncSelectionControls();
})();
