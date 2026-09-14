/**
 * The cosmetic viewer on the catalogue and videos pages.
 *
 * A card carries what the viewer shows in data attributes, escaped by the
 * template. Nothing here builds markup from them: every value goes through
 * textContent, a property or setAttribute, so a name with angle brackets in it
 * is shown as text rather than run.
 *
 * `?open=<id>` in the address opens that cosmetic on load, so a link to one can
 * be pasted into a message — provided it is on the page the link points at.
 */
(() => {
  const modalElement = document.getElementById('cosmeticModal');
  if (!modalElement || !window.bootstrap) return;

  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const SOURCES = ['clip', 'youtube', 'image'];

  const modal = window.bootstrap.Modal.getOrCreateInstance(modalElement);
  const field = (name) => modalElement.querySelector(`[data-field="${name}"]`);
  let current = null;

  function setOpenParam(id) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('open', id);
    else url.searchParams.delete('open');
    window.history.replaceState(null, '', url);
  }

  function player(source) {
    if (source === 'clip') {
      const video = document.createElement('video');
      video.className = 'fg-video';
      video.src = current.clip;
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      return video;
    }
    if (source === 'youtube') {
      const frame = document.createElement('iframe');
      frame.className = 'fg-youtube';
      frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(current.youtube)}?autoplay=1&mute=1&rel=0`;
      frame.title = `${current.name} — YouTube showcase`;
      frame.allow = 'autoplay; encrypted-media; picture-in-picture';
      frame.allowFullscreen = true;
      // The panel sends no referrer, and YouTube refuses to play an embed
      // that arrives without one. This frame alone gets the default policy.
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      return frame;
    }
    if (current.image) {
      const image = document.createElement('img');
      image.className = 'fg-picture';
      image.src = current.image;
      image.alt = current.name;
      return image;
    }
    const empty = document.createElement('div');
    empty.className = 'fg-stage-empty';
    empty.textContent = 'No picture or video for this cosmetic.';
    return empty;
  }

  function show(source) {
    modalElement.querySelectorAll('[data-source]').forEach((button) => {
      const selected = button.dataset.source === source;
      button.classList.toggle('btn-kd', selected);
      button.classList.toggle('btn-kd-outline', !selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    field('stage').replaceChildren(player(source));
  }

  function open(card) {
    const data = card.dataset;
    current = {
      id: data.id,
      name: data.name || data.id,
      clip: data.clip || '',
      youtube: YOUTUBE_ID.test(data.youtube || '') ? data.youtube : '',
      image: data.image || '',
    };

    field('name').textContent = current.name;
    field('meta').textContent = data.meta || '';
    field('description').textContent = data.description || '';
    field('id').textContent = current.id;
    field('api').href = `/api/v1/cosmetics/${encodeURIComponent(current.id)}`;
    field('file').href = current.clip || '#';
    field('file').hidden = !current.clip;

    const available = SOURCES.filter((source) => current[source]);
    modalElement.querySelectorAll('[data-source]').forEach((button) => {
      button.hidden = !available.includes(button.dataset.source);
    });
    field('sources').hidden = available.length < 2;

    show(available[0] ?? 'image');
    setOpenParam(current.id);
    modal.show();
  }

  // Emptying the stage is what stops a video or embed from playing on behind
  // a closed dialog.
  modalElement.addEventListener('hidden.bs.modal', () => {
    field('stage').replaceChildren();
    current = null;
    setOpenParam(null);
  });

  document.addEventListener('click', (event) => {
    const card = event.target.closest('[data-cosmetic]');
    if (card) {
      open(card);
      return;
    }
    const source = event.target.closest('[data-source]');
    if (source && current) show(source.dataset.source);
  });

  const wanted = new URLSearchParams(window.location.search).get('open');
  if (wanted) {
    const card = Array.from(document.querySelectorAll('[data-cosmetic]')).find((c) => c.dataset.id === wanted);
    if (card) open(card);
  }
})();
