/*
 * Admin panel behaviour.
 *
 * Everything here is progressive enhancement — the panel is server-rendered and every action is
 * a real form submit, so it works with JavaScript disabled or still loading. This file only makes
 * the common paths quicker.
 */

(function () {
  'use strict';

  const iconsReady = () => window.lucide?.createIcons();
  iconsReady();

  // ── Sidebar (mobile) ────────────────────────────────────────────────────
  const sidebar = document.getElementById('scSidebar');
  const scrim = document.getElementById('scScrim');
  const toggle = document.getElementById('scMenuToggle');

  // is-open, not d-none. The stylesheet holds the scrim at opacity 0 with
  // pointer-events: none until it is opened, so removing d-none revealed an
  // invisible element nothing could click: the backdrop never appeared and
  // tapping outside the drawer did nothing.
  function closeSidebar() {
    sidebar?.classList.remove('is-open');
    scrim?.classList.remove('is-open');
  }

  toggle?.addEventListener('click', () => {
    const open = sidebar?.classList.toggle('is-open');
    scrim?.classList.toggle('is-open', Boolean(open));
  });
  scrim?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  // ── File drop zones ─────────────────────────────────────────────────────
  //
  // Showing the chosen file immediately is the single most useful thing here: uploading the
  // wrong template and only finding out on the detail page is the classic admin-panel mistake.
  document.querySelectorAll('[data-dropzone]').forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const preview = document.getElementById(zone.dataset.preview);
    const empty = zone.querySelector('[data-dropzone-empty]');
    if (!input) return;

    const showPreview = (file) => {
      if (!file || !preview) return;
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.classList.remove('d-none');
      empty?.classList.add('d-none');
      // Release the blob once the browser has decoded it; these can be several megabytes.
      preview.onload = () => URL.revokeObjectURL(url);
    };

    input.addEventListener('change', () => showPreview(input.files?.[0]));

    ['dragenter', 'dragover'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('is-dragging');
      })
    );

    ['dragleave', 'drop'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('is-dragging');
      })
    );

    zone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      // Assigning through DataTransfer is the only way to programmatically set a file input.
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      showPreview(file);
    });
  });

  // ── Tag suggestions ─────────────────────────────────────────────────────
  const tagInput = document.getElementById('tags');
  document.querySelectorAll('[data-tag-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!tagInput) return;
      const tag = button.dataset.tagSuggestion;
      const current = tagInput.value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (current.includes(tag)) return;
      current.push(tag);
      tagInput.value = current.join(', ');
      tagInput.focus();
    });
  });

  // ── Filters submit on change ────────────────────────────────────────────
  document.querySelectorAll('[data-auto-submit]').forEach((control) => {
    control.addEventListener('change', () => control.form?.submit());
  });

  // ── Destructive action confirmation ─────────────────────────────────────
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  // ── Optimistic featured toggle ──────────────────────────────────────────
  //
  // Featuring is the action an editor repeats most while curating, and a full page reload for
  // each one loses scroll position. Post in the background and flip the button locally instead;
  // any failure falls back to a normal submit so the user is never left guessing.
  document.querySelectorAll('form[data-quick-action]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button?.setAttribute('disabled', 'disabled');

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-CSRF-Token': form.querySelector('[name="_csrf"]').value },
          body: new URLSearchParams(new FormData(form)),
        });
        if (!response.ok) throw new Error('Request failed');

        const payload = await response.json();
        const isOn = payload.data.featured ?? payload.data.published;
        button?.classList.toggle('is-on', Boolean(isOn));

        const icon = button?.querySelector('svg, i');
        if (icon) {
          icon.setAttribute('fill', isOn ? 'currentColor' : 'none');
        }
        // Reflect the change in the card's badge row without a reload.
        const card = form.closest('.ad-skin-card-wrap');
        const flags = card?.querySelector('.ad-skin-flags');
        const existing = flags?.querySelector('.ad-badge.featured');
        if (isOn && flags && !existing) {
          const badge = document.createElement('span');
          badge.className = 'ad-badge featured';
          badge.textContent = 'Featured';
          flags.prepend(badge);
        } else if (!isOn && existing) {
          existing.remove();
        }
      } catch {
        form.submit();
      } finally {
        button?.removeAttribute('disabled');
      }
    });
  });

  // ── Selecting several skins ─────────────────────────────────────────────
  //
  // Enhancement only. The checkboxes point at the bulk form through their
  // `form` attribute, so ticking and submitting already works without this —
  // what this adds is the count, the select-all, and being asked before
  // something irreversible happens to a dozen things at once.
  const bulkForm = document.querySelector('[data-bulk]');

  if (bulkForm) {
    const count = bulkForm.querySelector('[data-bulk-count]');
    const submit = bulkForm.querySelector('[data-bulk-delete]');
    const all = bulkForm.querySelector('[data-bulk-all]');
    const boxes = Array.from(document.querySelectorAll('.ad-skin-pick input[type="checkbox"]'));

    const selected = () => boxes.filter((b) => b.checked);

    function reflect() {
      const n = selected().length;
      count.textContent = n === 0
        ? 'None selected'
        : `${n} selected`;
      submit.disabled = n === 0;
      if (all) {
        all.checked = n > 0 && n === boxes.length;
        // Neither on nor off: some are ticked. Without this the header box
        // claims everything is selected the moment one card is.
        all.indeterminate = n > 0 && n < boxes.length;
      }
    }

    boxes.forEach((box) => box.addEventListener('change', reflect));

    all?.addEventListener('change', () => {
      boxes.forEach((box) => { box.checked = all.checked; });
      reflect();
    });

    bulkForm.addEventListener('submit', (event) => {
      const n = selected().length;
      if (n === 0) { event.preventDefault(); return; }
      // Named rather than counted when it is one, because "delete 1 skin" reads
      // like a rounding error and this removes files.
      const what = n === 1
        ? `“${selected()[0].closest('.ad-skin-card-wrap')?.querySelector('.ad-skin-title')?.textContent?.trim() ?? 'this skin'}”`
        : `${n} skins`;
      if (!window.confirm(`Delete ${what}? This removes their files too and can't be undone.`)) {
        event.preventDefault();
      }
    });

    reflect();
  }

  // ── Preview tabs (skin page) ────────────────────────────────────────────
  //
  // `hidden` rather than a class, because the avatar canvas has to be laid out
  // before it is drawn: a canvas in a `display:none` parent measures zero, and
  // the renderer would size itself to nothing and paint an empty box.
  const viewTabs = Array.from(document.querySelectorAll('[data-view-tab]'));

  viewTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const wanted = tab.dataset.viewTab;
      viewTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('[data-view-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.viewPanel !== wanted;
      });
      // The avatar sizes itself from its element, which only has a size once
      // it is visible. Nudging resize makes it re-measure on first reveal.
      window.dispatchEvent(new Event('resize'));
    });
  });

  // ── AI: planning, then generating ───────────────────────────────────────
  //
  // Both are one long request, and both used to be silent. Generation showed
  // nothing but the browser's tab spinner — indistinguishable from a hung page,
  // which is how the same prompt got submitted twice and billed twice.
  //
  // Planning exists so the argument about what the design should be happens
  // while it is still only text tokens. It streams because a plan you can watch
  // arrive is one you interrupt; a paragraph that appears all at once has
  // already decided.
  const aiForm = document.querySelector('form[data-ai-form]');

  if (aiForm) {
    const el = (name) => aiForm.querySelector(`[data-ai-${name}]`);

    const status = el('status');
    const statusTitle = el('status-title');
    const statusDetail = el('status-detail');
    const errorBox = el('error');
    const errorText = el('error-text');
    const submit = el('submit');

    const planButton = el('plan');
    const panel = el('plan-panel');
    const planText = el('plan-text');
    const planSpinner = el('plan-spinner');
    const planIcon = el('plan-icon');
    const planReply = el('plan-reply');
    const planSend = el('plan-send');
    const planAccept = el('plan-accept');
    const donePanel = el('done');
    const doneLink = el('done-link');

    // The conversation so far, so a follow-up is a correction rather than a
    // fresh start. Sent back on each turn and bounded server-side.
    let history = [];
    let directions = null;
    let ticker = null;
    let navigating = false;

    const csrf = () => aiForm.querySelector('[name="_csrf"]').value;
    const field = (name) => aiForm.querySelector(`[name="${name}"]`);
    const stopTicker = () => { if (ticker) window.clearInterval(ticker); ticker = null; };

    // Each image is its own round trip to the provider, so three panels really
    // is three times the wait. Saying which one it is on is what stops the
    // pause reading as a hang.
    const faceNames = {
      front: 'the front', back: 'the back', pattern: 'the side pattern',
      chest: 'the chest', sleeve: 'a sleeve', waist: 'the waist',
      legFront: 'the front of a leg', legBack: 'the back of a leg', leg: 'a leg',
    };

    // What each combination costs, handed over by the server so the page and
    // the pipeline cannot disagree about it.
    const costs = JSON.parse(aiForm.dataset.aiCosts || '{}');

    const styleInput = () => aiForm.querySelector('[name="style"]:checked');
    const currentStyle = () => styleInput()?.value ?? 'pattern';
    const panelCount = () => {
      const forCategory = costs[field('category').value] || {};
      return currentStyle() === 'garment'
        ? (forCategory.garment ?? 3)
        : (forCategory[field('quality').value] ?? 2);
    };

    // ── What the description should say ──────────────────────────────────
    //
    // The two modes want opposite things typed into the same box. Pattern mode
    // must not be told "a shirt", because that draws a picture of a shirt onto
    // a shirt; garment mode wants exactly that. Leaving one set of instructions
    // up for both is how someone follows the wrong one.
    const descriptionLabel = el('description-label');
    const descriptionHelp = el('description-help');
    const qualityField = el('quality-field');
    const costField = el('cost-field');
    const costOut = el('cost');

    function reflectStyle() {
      const garment = currentStyle() === 'garment';

      descriptionLabel.textContent = garment
        ? 'What are the clothes?'
        : 'What should it look like?';

      descriptionHelp.innerHTML = garment
        ? 'Describe the <em>garment</em> — “a navy office dress shirt with a white '
          + 'collar and pearl buttons”, “a charcoal cable-knit sweater”. Cut, fabric '
          + 'and colour all help.'
        : 'Describe the <em>artwork</em>, not the garment. “Blue galaxy pattern”, '
          + 'not “a shirt with a galaxy on it” — asking for a shirt gets you a '
          + 'picture of a shirt, printed on a shirt.';

      // Detail is a pattern-mode choice. In garment mode the number of panels
      // is decided by the body, not by taste.
      qualityField.hidden = garment;
      costField.hidden = !garment;
      costOut.textContent = `${panelCount()} panels`;

      const placeholder = garment
        ? 'A navy office dress shirt with a white collar and pearl buttons'
        : 'A deep blue galaxy with purple nebula clouds and small white stars';
      field('description').placeholder = placeholder;
    }

    aiForm.querySelectorAll('[name="style"]').forEach((input) => {
      input.addEventListener('change', () => {
        // A plan describes panels that no longer exist once the mode changes.
        directions = null;
        history = [];
        panel.hidden = true;
        reflectStyle();
      });
    });
    field('category').addEventListener('change', reflectStyle);
    field('quality').addEventListener('change', reflectStyle);
    reflectStyle();

    // ── Planning ──────────────────────────────────────────────────────────


    const fail = (message) => {
      errorText.textContent = message;
      errorBox.hidden = false;
      iconsReady();
    };

    /**
     * Reads a server-sent-event stream from a POST.
     *
     * `EventSource` cannot do this — it is GET-only, and these need a CSRF
     * header and a body. Events are separated by a blank line and a chunk can
     * split anywhere, so the tail is carried rather than parsed.
     */
    async function stream(url, body, onEvent) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'X-CSRF-Token': csrf() },
        body,
      });

      // A failure before the stream opened is still a normal response, and its
      // body is likelier to explain itself than its status code is.
      if (!response.ok || !response.body) {
        throw new Error(`The server returned ${response.status} before the stream started.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;

          let payload;
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            // One unreadable frame is one lost update, not a dead stream.
            continue;
          }

          // A handler that says it is finished ends the read here, so the
          // response is closed deliberately rather than abandoned half-read.
          if (onEvent(payload) === 'stop') {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }
    }

    // ── Ideas ─────────────────────────────────────────────────────────────
    //
    // Fills the description rather than generating anything. Choosing an idea
    // is the start of the process, not a commitment to it: the plan step still
    // follows, and nothing is drawn until Generate.
    const ideasTheme = el('ideas-theme');
    const ideasGo = el('ideas-go');
    const ideasList = el('ideas-list');

    if (ideasGo) {
      ideasGo.addEventListener('click', async () => {
        errorBox.hidden = true;
        ideasGo.setAttribute('disabled', 'disabled');
        ideasList.hidden = false;
        ideasList.textContent = 'Thinking of ideas…';

        try {
          const response = await fetch('/admin/skins/ai/ideas', {
            method: 'POST',
            headers: { Accept: 'application/json', 'X-CSRF-Token': csrf() },
            body: new URLSearchParams({
              theme: ideasTheme.value.trim(),
              category: field('category').value,
            }),
          });

          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload?.data?.ideas?.length) {
            throw new Error(payload?.message || `The server returned ${response.status}.`);
          }

          ideasList.textContent = '';
          for (const idea of payload.data.ideas) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ad-idea';

            const name = document.createElement('strong');
            name.textContent = idea.name;
            const detail = document.createElement('span');
            detail.textContent = idea.description;
            button.append(name, detail);

            button.addEventListener('click', () => {
              field('description').value = idea.description;
              // Choosing a different idea must not leave the previous plan on
              // screen looking like it describes this one.
              directions = null;
              history = [];
              panel.hidden = true;
              ideasList.querySelectorAll('.ad-idea').forEach((other) => {
                other.classList.toggle('is-chosen', other === button);
              });
              field('description').focus();
            });

            ideasList.appendChild(button);
          }
        } catch (error) {
          ideasList.hidden = true;
          fail(error.message);
        } finally {
          ideasGo.removeAttribute('disabled');
          iconsReady();
        }
      });

      // Enter asks for ideas rather than submitting the form, which would
      // start a generation from an empty description.
      ideasTheme.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); ideasGo.click(); }
      });
    }

    // ── Planning ──────────────────────────────────────────────────────────
    async function plan(instruction) {
      const description = field('description').value.trim();
      if (!description) { field('description').reportValidity(); return; }

      errorBox.hidden = true;
      panel.hidden = false;
      planSpinner.hidden = false;
      planIcon.hidden = true;
      planText.textContent = '';
      planAccept.setAttribute('disabled', 'disabled');
      planButton?.setAttribute('disabled', 'disabled');
      planSend.setAttribute('disabled', 'disabled');
      iconsReady();

      // FormData rather than URLSearchParams, because a reference picture is
      // a file. Sent multipart whether or not one was chosen, so there is one
      // request shape to reason about instead of two.
      const body = new FormData();
      body.append('description', field('description').value.trim());
      body.append('category', field('category').value);
      body.append('quality', field('quality').value);
      body.append('style', currentStyle());
      body.append('title', field('title').value);
      body.append('directions', JSON.stringify(directions));
      body.append('plan', planText.textContent || '');

      const referenceFile = field('reference')?.files?.[0];
      if (referenceFile) body.append('reference', referenceFile);

      let full = '';
      try {
        await stream('/admin/skins/ai/plan', body, (event) => {
          if (event.type === 'delta') {
            full += event.text;
            planText.textContent = full;
            // Follow the newest line rather than making someone chase it.
            planText.scrollTop = planText.scrollHeight;
          } else if (event.type === 'plan') {
            // The prose is what a person reads; the JSON block underneath is
            // for the image model, and showing it would be noise.
            planText.textContent = event.reasoning || full;
            directions = event.directions;
            history = history.concat(
              { role: 'user', content: instruction || description },
              { role: 'assistant', content: full },
            );
            planAccept.removeAttribute('disabled');
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        });
      } catch (error) {
        fail(error.message);
        panel.hidden = !full;
      } finally {
        planSpinner.hidden = true;
        planIcon.hidden = false;
        planButton?.removeAttribute('disabled');
        planSend.removeAttribute('disabled');
        iconsReady();
      }
    }

    planButton?.addEventListener('click', () => { history = []; plan(null); });

    planSend.addEventListener('click', () => {
      const reply = planReply.value.trim();
      if (!reply) return;
      planReply.value = '';
      plan(reply);
    });

    // Enter sends the follow-up instead of submitting the form, which would
    // start a generation nobody asked for.
    planReply.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); planSend.click(); }
    });

    // ── Generating ────────────────────────────────────────────────────────
    async function generate() {
      const count = panelCount();
      const started = Date.now();

      errorBox.hidden = true;
      status.hidden = false;
      status.classList.add('is-busy');
      statusTitle.textContent = count === 1
        ? 'Generating 1 panel…'
        : `Generating ${count} panels…`;
      statusDetail.textContent = 'Starting…';
      submit.setAttribute('disabled', 'disabled');
      planAccept.setAttribute('disabled', 'disabled');
      iconsReady();

      let location = null;
      let step = 'Starting…';
      const tick = () => {
        const seconds = Math.round((Date.now() - started) / 1000);
        statusDetail.textContent = `${step} · ${seconds}s elapsed`;
      };
      tick();
      ticker = window.setInterval(tick, 1000);

      const body = new URLSearchParams({
        description: field('description').value.trim(),
        category: field('category').value,
        quality: field('quality').value,
        style: currentStyle(),
        title: field('title').value,
        directions: JSON.stringify(directions),
        plan: planText.textContent || '',
      });

      try {
        await stream('/admin/skins/ai/generate', body, (event) => {
          if (event.type === 'progress') {
            if (event.stage === 'image') {
              step = `Drawing ${faceNames[event.face] ?? event.face} — ${event.index + 1} of ${event.total}`;
            } else if (event.stage === 'compose') {
              step = 'Composing the template sheet';
            } else if (event.stage === 'storing') {
              step = 'Saving the draft';
            }
            tick();
          } else if (event.type === 'done') {
            navigating = true;
            location = event.location;
            stopTicker();
            statusDetail.textContent = '';
            // Stop reading before going anywhere. Navigating out of a response
            // that is still open leaves the browser tearing down a connection
            // at the same moment it is trying to use one, and the draft is
            // already saved by this point — there is nothing left to wait for.
            return 'stop';
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        });

        if (navigating && location) {
          // Deliberately does not navigate.
          //
          // Sending the browser to the draft the instant the stream ended kept
          // landing on an error page, on a request that worked perfectly a
          // moment later on refresh. Three attempts at the cause — a stale
          // upstream connection, navigating out of an open response, closing
          // the stream first — each fixed something real and none of them fixed
          // this.
          //
          // The generation is finished and paid for by this point, so the one
          // thing that must not happen is losing it to a failed navigation.
          // Showing where it is always works; going there automatically does
          // not. It also leaves the form ready for the next one, which is what
          // happens more often than not.
          doneLink.href = location;
          donePanel.hidden = false;
          statusTitle.textContent = 'Done';
          return;
        }

        // The stream ended without saying it finished. Treat it as a failure
        // rather than leaving a spinner up forever — but say what almost
        // certainly happened, because the images were paid for either way and
        // the server finishes and saves the draft regardless of this end of the
        // connection surviving.
        if (!navigating) {
          throw new Error(
            'The connection dropped before the design finished, but the server keeps going — '
            + 'your draft is almost certainly in Drafts. Check there before generating again, '
            + 'so you are not billed twice.',
          );
        }
      } catch (error) {
        const message =
          error instanceof TypeError
            ? 'Lost the connection while generating. The server keeps going, so the draft is probably in Drafts — check there before trying again, so you are not billed twice.'
            : error.message;
        fail(message);
      } finally {
        stopTicker();
        status.hidden = true;
        status.classList.remove('is-busy');
        submit.removeAttribute('disabled');
        if (directions) planAccept.removeAttribute('disabled');
      }
    }

    planAccept.addEventListener('click', () => generate());

    aiForm.addEventListener('submit', (event) => {
      if (!aiForm.reportValidity()) return;
      event.preventDefault();
      // A plain Generate ignores any plan on screen: the button says "as
      // draft", not "as planned", and silently folding in a plan the person
      // did not accept would be the page deciding for them.
      directions = null;
      generate();
    });
  }
})();
