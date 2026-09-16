'use strict';
/**
 * Small fetch wrapper.
 *
 * Node 20 (which Electron 44 ships) has global fetch, so there is no HTTP
 * dependency to install. What it does not give us is a default timeout - a
 * hung request would otherwise leave the app spinning forever - or a readable
 * error when a provider answers with an HTML error page instead of JSON.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

class HttpError extends Error {
  constructor(status, body, url) {
    // Providers put the useful part in different places; try the common ones
    // before falling back to the raw body, truncated so a 200 KB HTML error
    // page does not end up in a dialog box.
    const detail =
      (body && (body.detail || body.error?.message || body.error || body.message)) ||
      (typeof body === 'string' ? body.slice(0, 400) : '');
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** Combines a caller's AbortSignal with our own timeout. */
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms}ms`)), ms);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function request(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = opts;
  const t = withTimeout(signal, timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...rest, signal: t.signal });
  } finally {
    t.done();
  }

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text();

  if (!res.ok) throw new HttpError(res.status, payload, url);
  return payload;
}

function getJson(url, { headers, ...rest } = {}) {
  return request(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, ...rest });
}

function postJson(url, body, { headers, ...rest } = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    ...rest,
  });
}

/** Fetches binary content (a finished image) as a Buffer. */
async function getBuffer(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t = withTimeout(signal, timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: t.signal });
  } finally {
    t.done();
  }
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
  return Buffer.from(await res.arrayBuffer());
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(id);
          reject(signal.reason || new Error('aborted'));
        },
        { once: true },
      );
    }
  });

module.exports = { request, getJson, postJson, getBuffer, sleep, HttpError };
