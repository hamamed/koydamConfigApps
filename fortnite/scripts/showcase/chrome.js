import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FRAME } from './page.js';

const STARTUP_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const LAYERS = ['page', 'card', 'art', 'info'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome writes the port it chose to this file once DevTools is listening. */
async function devToolsPort(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port] = (await readFile(file, 'utf8')).split('\n');
      if (port) return Number(port);
    }
    await sleep(100);
  }
  throw new Error('Chrome did not start its DevTools server');
}

function connect(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  let nextId = 0;
  let closedError = null;

  // A dead connection fails every call in flight at once. Without this, a
  // Chrome that crashed mid-render left each pending call to its own timeout.
  const failAll = (error) => {
    closedError ??= error;
    waiting.forEach((pending) => pending.reject(error));
    waiting.clear();
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result);
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closedError) {
      reject(closedError);
      return;
    }
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} timed out`));
    }, CALL_TIMEOUT_MS);
    waiting.set(id, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => {
      const error = new Error('lost the connection to Chrome');
      reject(error);
      failAll(error);
    };
    socket.onclose = () => failAll(new Error('Chrome closed the connection'));
  });
  return { opened, send, close: () => socket.close() };
}

/**
 * A headless Chrome that draws showcase layers.
 *
 * One page, reused: loading the fonts once is most of the cost. Renders are
 * serialised — the page holds one card at a time — so callers may ask
 * concurrently and simply queue.
 *
 * @param {{ chrome: string, html: string }} options
 */
export async function launchRenderer({ chrome, html }) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'showcase-chrome-'));
  const profile = path.join(work, 'profile');
  const pagePath = path.join(work, 'sheet.html');
  await writeFile(pagePath, html);

  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });

  const exited = new Promise((resolve) => child.once('exit', resolve));

  // A binary that exists but cannot run (quarantined, not executable) emits
  // 'error' rather than exiting. Unheard, that is an uncaught exception that
  // kills the batch before its cleanup or its failure report; heard, it ends
  // start-up as an ordinary rejection.
  const failedToStart = new Promise((_, reject) => {
    child.on('error', (error) => reject(new Error(`Chrome could not start: ${error.message}`)));
  });
  failedToStart.catch(() => {});

  let client = null;
  // Chrome writes to its profile while it shuts down, so deleting the profile
  // straight after kill() raced it and failed with ENOTEMPTY — after every clip
  // had rendered, turning a clean run into a failed exit.
  const close = async () => {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS)]);
    }
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    const port = await Promise.race([devToolsPort(profile), failedToStart]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === 'page');
    if (!target) throw new Error('Chrome opened no page');

    client = connect(target.webSocketDebuggerUrl);
    await client.opened;
    const { send } = client;

    await send('Emulation.setDeviceMetricsOverride', { ...FRAME, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.enable');
    await send('Page.navigate', { url: pathToFileURL(pagePath).href });
    await waitFor(send, 'typeof window.renderCard === "function"');

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };

    const capture = async (clip) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      return Buffer.from(data, 'base64');
    };

    let queue = Promise.resolve();

    /** Draws one card and returns its four layers as PNG buffers, plus where the hero sits. */
    const render = (card) => {
      const job = queue.then(async () => {
        const layout = await evaluate(`window.renderCard(${JSON.stringify(card)})`);
        const full = { x: 0, y: 0, ...FRAME };
        // The artwork layer is cut to the hero, so ffmpeg can scale it about its own centre.
        const heroClip = {
          x: Math.round(layout.hero.x), y: Math.round(layout.hero.y),
          width: Math.round(layout.hero.width), height: Math.round(layout.hero.height),
        };
        const layers = {};
        for (const layer of LAYERS) {
          await evaluate(`window.showLayer(${JSON.stringify(layer)})`);
          layers[layer] = await capture(layer === 'art' ? heroClip : full);
        }
        await evaluate('window.showLayer("all")');
        return { layers, hero: heroClip, scale: layout.scale };
      });
      queue = job.catch(() => {});
      return job;
    };

    return { render, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function waitFor(send, expression) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result?.value === true) return;
    await sleep(100);
  }
  throw new Error(`page never satisfied: ${expression}`);
}
