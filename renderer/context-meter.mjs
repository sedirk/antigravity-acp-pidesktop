// PI 0.22 renderer extension. Keep this entry self-contained for blob loaders.
import { createElement as h, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

const POLL_MS = 2200;
const DEADLINE_MS = 2500; // stock plugin.call also has its own 2s deadline
const MAX_AGE_MS = 10 * 60 * 1000;
const VISIBLE = { visibilityProperty: true, checkVisibilityCSS: true };
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const positive = (v) => count(v) && v > 0;
const identifier = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v === v.trim() && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
const fresh = (at, expires, now) => positive(at) && positive(expires) && at <= now && now < expires && now - at < MAX_AGE_MS;

function readSample(value, sessionId, now) {
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId) return null;
  const { sampledAt, expiresAt, phase, providerId, modelId, budget, upstream } = value;
  if (phase !== 'sample' || !fresh(sampledAt, expiresAt, now) || !identifier(providerId) || !identifier(modelId)) return null;
  if (budget !== undefined && (!record(budget) || !count(budget.tokens) || !positive(budget.limit))) return null;
  if (upstream !== undefined && (!record(upstream) || !count(upstream.used)
    || (upstream.size !== undefined && !positive(upstream.size)))) return null;
  if (budget === undefined && upstream === undefined) return null;
  return {
    sampledAt, expiresAt, providerId, modelId,
    budget: budget && { tokens: budget.tokens, limit: budget.limit },
    upstream: upstream && { used: upstream.used, size: upstream.size },
  };
}

function sameSample(a, b) {
  return a === b || Boolean(a && b && a.sampledAt === b.sampledAt && a.expiresAt === b.expiresAt
    && a.providerId === b.providerId && a.modelId === b.modelId
    && a.budget?.tokens === b.budget?.tokens && a.budget?.limit === b.budget?.limit
    && a.upstream?.used === b.upstream?.used && a.upstream?.size === b.upstream?.size);
}

function visible(element) {
  return element.isConnected && typeof element.checkVisibility === 'function'
    && element.checkVisibility(VISIBLE);
}

function createWitnesses() {
  const groups = new Map();
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    add(sessionId, marker) {
      const group = groups.get(sessionId) ?? new Set();
      groups.set(sessionId, group);
      const first = group.size === 0;
      group.add(marker);
      if (first) changed();
      return () => {
        const representative = group.values().next().value === marker;
        group.delete(marker);
        if (group.size === 0) groups.delete(sessionId);
        if (representative) changed();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get hasMarkers() { return groups.size !== 0; },
    uniqueVisibleId() {
      let id = null;
      for (const [sessionId, group] of groups) {
        // Stock has one pane per session ID. Measure one of our own empty
        // markers per pane, not every reply. Offscreen scrolling is fine;
        // retained panes are mounted but their content is explicitly hidden.
        if (!visible(group.values().next().value)) continue;
        if (id !== null) return null;
        id = sessionId;
      }
      return id;
    },
  };
}

function createView() {
  let snapshot = null;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(sample, epoch, lang) {
      if (sample ? epoch === snapshot?.epoch && lang === snapshot.lang && sameSample(sample, snapshot.sample) : !snapshot) return;
      snapshot = sample ? { sample, epoch, lang } : null;
      for (const listener of listeners) listener();
    },
  };
}

function monitor(pi, witnesses, anchor, view) {
  let sessionId = null;
  let epoch = 0;
  let newest = 0;
  let failures = 0;
  let pending = null;
  let wake = 0;
  let deadline = 0;
  let frame = 0;
  let disposed = false;
  let focused = document.hasFocus();
  let online = navigator.onLine !== false;
  let pagePresent = true;

  function reset() {
    clearTimeout(wake);
    clearTimeout(deadline);
    wake = deadline = 0;
    pending = null;
    sessionId = null;
    newest = failures = 0;
    epoch += 1;
    view.publish(null);
  }
  function active() {
    return !disposed && pagePresent && focused && document.hasFocus() && !document.hidden
      && online && navigator.onLine !== false;
  }
  function language() {
    // The renderer API has no locale getter. Match inherited language on
    // our own element, without querying or observing the host document tree.
    return anchor.matches(':lang(zh)') ? 'zh' : 'en';
  }
  function measure() {
    const awake = active() && witnesses.hasMarkers;
    // Both checks read only plugin-owned nodes. The scoped sheet also hides
    // our anchor while the stock chat surface declares itself busy (cold switch).
    const id = awake && visible(anchor) ? witnesses.uniqueVisibleId() : null;
    if (id !== sessionId) {
      reset();
      sessionId = id;
      if (id !== null) wake = setTimeout(poll, 0); // after layout/commit finishes
    }
    const shown = view.getSnapshot()?.sample;
    if (shown) {
      view.publish(fresh(shown.sampledAt, shown.expiresAt, Date.now()) ? shown : null, epoch, language());
    }
    if (awake && !frame) frame = requestAnimationFrame(tick);
    if (!awake && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }
  function tick() {
    frame = 0;
    measure();
  }
  function poll() {
    wake = 0;
    const owner = sessionId;
    const startEpoch = epoch;
    measure();
    if (owner === null || startEpoch !== epoch || pending !== null) return;
    const job = {};
    pending = job;
    const until = performance.now() + DEADLINE_MS;
    const finish = (answer, failed = false) => {
      if (job !== pending) return;
      measure(); // a visibility/switch change may predate its next animation frame
      if (job !== pending) return;
      clearTimeout(deadline);
      deadline = 0;
      pending = null;
      failed ||= performance.now() >= until;
      const sample = failed ? null : readSample(answer, owner, Date.now());
      if (sample && sample.sampledAt >= newest) {
        newest = sample.sampledAt;
        view.publish(sample, epoch, language());
      } else {
        view.publish(null);
      }
      failures = failed ? Math.min(failures + 1, 4) : 0;
      wake = setTimeout(poll, failures ? Math.min(POLL_MS * 2 ** failures, 15000) : POLL_MS);
    };
    deadline = setTimeout(() => finish(null, true), DEADLINE_MS);
    void Promise.resolve().then(() => {
      if (pending !== job) return null;
      return pi.dispatch('plugin.call', { method: 'readContextMeter', args: { sessionId: owner } });
    }).then((value) => finish(value), () => finish(null, true));
  }

  const lifecycle = (event) => {
    if (event.type === 'blur' || event.type === 'focus') focused = event.type === 'focus';
    if (event.type === 'online' || event.type === 'offline') online = event.type === 'online';
    if (event.type === 'pagehide' || event.type === 'pageshow') pagePresent = event.type === 'pageshow';
    reset(); // even returning to the same ID requires a new confirmation
    measure();
  };
  const events = ['blur', 'focus', 'offline', 'online', 'pagehide', 'pageshow'];
  for (const name of events) window.addEventListener(name, lifecycle);
  document.addEventListener('visibilitychange', lifecycle);
  const unsubscribe = witnesses.subscribe(measure);
  measure();
  return () => {
    disposed = true;
    unsubscribe();
    for (const name of events) window.removeEventListener(name, lifecycle);
    document.removeEventListener('visibilitychange', lifecycle);
    cancelAnimationFrame(frame);
    reset();
  };
}

const COPY = {
  en: {
    last: 'Last', estimate: 'PI budget est.', short: 'Last PI est.', title: 'PI input budget estimate',
    source: 'Latest ACP request', description: 'Sample from the last ACP request on the named model. Not a live draft count, compaction trigger, standard usage, or bill.',
    model: 'Sampled model', at: 'Budget sampled at', budget: 'Est. input / hard input limit',
    upstream: 'ACP context (as reported)', used: 'Occupied', size: 'Window size',
    unknown: 'Not reported', close: 'Close details', tokens: 'tokens',
  },
  zh: {
    last: '最近', estimate: 'PI 预算估算', short: '最近 PI 估算', title: 'PI 输入预算估算',
    source: '最近 ACP 请求', description: '对应下方模型最近一次 ACP 请求的采样，不随草稿逐字计数。不是压缩触发线、标准用量或计费数据。',
    model: '采样模型', at: '预算采样时间', budget: '输入估算 / 输入硬限额',
    upstream: 'ACP 水位（上游实报）', used: '已占用', size: '窗口大小',
    unknown: '未报告', close: '关闭明细', tokens: 'tokens',
  },
};
const NUMBERS = { en: new Intl.NumberFormat('en'), zh: new Intl.NumberFormat('zh-CN') };
const dateOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
const DATES = { en: new Intl.DateTimeFormat('en', dateOptions), zh: new Intl.DateTimeFormat('zh-CN', dateOptions) };

function percent({ tokens, limit }, number) {
  const denominator = BigInt(limit);
  const rounded = (100n * BigInt(tokens) + denominator / 2n) / denominator;
  if (rounded === 0n && tokens > 0) return '<1%';
  if (rounded === 100n && tokens !== limit) return tokens > limit ? '>100%' : '<100%';
  return `${number.format(rounded)}%`;
}

function Details({ anchor, panel, panelId, titleId, sample, copy, lang, ratio, close }) {
  useLayoutEffect(() => {
    const element = panel.current;
    let frame = 0;
    let last = '';
    const place = () => {
      const button = anchor.current;
      if (!button?.isConnected) return;
      const { right, top, bottom } = button.getBoundingClientRect();
      const width = Math.max(0, Math.min(348, window.innerWidth - 16));
      const left = Math.max(8, Math.min(right - width, window.innerWidth - 8 - width));
      const above = top - 14;
      const below = window.innerHeight - bottom - 14;
      const side = above >= 304 || above >= below ? 'above' : 'below';
      const room = side === 'above' ? above : below;
      const maxHeight = Math.max(0, Math.min(400, room < 128 ? window.innerHeight - 16 : room));
      const y = room < 128 ? 8 : side === 'above' ? window.innerHeight - top + 6 : bottom + 6;
      const placement = [width, left, side, maxHeight, y].join(':');
      if (placement !== last) {
        last = placement;
        Object.assign(element.style, {
          width: `${width}px`, left: `${left}px`, maxHeight: `${maxHeight}px`,
          top: room < 128 || side === 'below' ? `${y}px` : 'auto',
          bottom: room < 128 || side === 'below' ? 'auto' : `${y}px`,
        });
      }
      frame = requestAnimationFrame(place);
    };
    place();
    element.focus({ preventScroll: true });
    return () => cancelAnimationFrame(frame);
  }, [anchor, panel]);

  const num = NUMBERS[lang];
  const time = new Date(sample.sampledAt);
  const countText = (v) => v === undefined ? copy.unknown : `${num.format(v)} ${copy.tokens}`;
  return h('section', { ref: panel, className: 'acp-meter-panel', role: 'dialog', tabIndex: 0, id: panelId, 'aria-labelledby': titleId },
    h('header', { className: 'acp-meter-head' },
      h('div', null,
        h('div', { className: 'acp-meter-kicker' }, copy.source),
        h('h2', { id: titleId }, copy.title)),
      h('button', { type: 'button', className: 'acp-meter-close', 'aria-label': copy.close,
        title: copy.close, onClick: () => close(true) }, '×')),
    h('p', { className: 'acp-meter-note' }, copy.description),
    h('dl', { className: 'acp-meter-grid acp-meter-meta' },
      h('dt', null, copy.model), h('dd', null, h('bdi', null, sample.providerId), ' / ', h('bdi', null, sample.modelId)),
      h('dt', null, copy.at),
      h('dd', null, h('time', { dateTime: time.toISOString(), title: time.toISOString() }, DATES[lang].format(time)))),
    h('div', { className: 'acp-meter-readings' },
      h('div', { className: 'acp-meter-budget' },
        h('h3', null, copy.budget),
        h('p', { className: 'acp-meter-counts' }, sample.budget
          ? `${num.format(sample.budget.tokens)} / ${num.format(sample.budget.limit)} ${copy.tokens}` : copy.unknown),
        ratio && h('span', { className: 'acp-meter-ratio' }, ratio)),
      h('div', { className: 'acp-meter-raw' },
        h('h3', null, copy.upstream),
        h('dl', { className: 'acp-meter-grid' },
          h('dt', null, copy.used), h('dd', null, countText(sample.upstream?.used)),
          h('dt', null, copy.size), h('dd', null, countText(sample.upstream?.size))))));
}

function Chip({ pi, sample, lang }) {
  const copy = COPY[lang];
  const ratio = sample.budget ? percent(sample.budget, NUMBERS[lang]) : null;
  const anchor = useRef(null);
  const panel = useRef(null);
  const [layer, setLayer] = useState(null);
  const panelId = useId();
  const titleId = useId();
  function dismiss(restoreFocus) {
    setLayer(null);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  }
  function toggle() {
    if (layer) { dismiss(true); return; }
    try { setLayer(pi.ui.openLayer()); } catch { /* stopped while the user clicked */ }
  }
  useLayoutEffect(() => {
    if (!layer) return;
    const outside = (event) => {
      // Inspect membership of our nodes only; no selectors or host traversal.
      const path = event.composedPath();
      if (!path.includes(anchor.current) && !path.includes(panel.current)) setLayer(null);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('focusin', outside, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('focusin', outside, true);
      layer.close();
    };
  }, [layer]);
  const label = `${copy.source} · ${copy.title}: ${ratio ?? copy.unknown}`;
  return h('span', { className: 'acp-meter-inner', onKeyDown: (event) => {
    if (event.key === 'Escape' && layer) {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    }
  } },
    h('button', {
      type: 'button', className: 'acp-meter-chip', ref: anchor, title: label, 'aria-label': label,
      'aria-haspopup': 'dialog', 'aria-expanded': Boolean(layer), 'aria-controls': layer ? panelId : undefined,
      onClick: toggle,
      onKeyDown: (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          toggle();
        }
      },
    }, [
      h('span', { key: 'caption', className: 'acp-meter-caption', 'aria-hidden': true },
        h('span', { className: 'acp-meter-full' },
          h('span', { className: 'acp-meter-last' }, `${copy.last} · `), copy.estimate),
        h('span', { className: 'acp-meter-short' }, copy.short)),
      h('span', { key: 'value', className: 'acp-meter-value', 'aria-hidden': true }, ratio ?? '—'),
    ]),
    layer && createPortal(h(Details, { anchor, panel, panelId, titleId, sample, copy, lang, ratio, close: dismiss }), layer.element));
}

export function onLoad(pi) {
  const witnesses = createWitnesses();
  function SessionWitness({ sessionId }) {
    const marker = useRef(null);
    useLayoutEffect(() => {
      if (identifier(sessionId) && marker.current) return witnesses.add(sessionId, marker.current);
    }, [sessionId]);
    return h('span', { ref: marker, className: 'acp-meter-witness', 'aria-hidden': true });
  }
  function Control({ position }) {
    const anchor = useRef(null);
    const view = useMemo(createView, []);
    const shown = useSyncExternalStore(view.subscribe, view.getSnapshot);
    useLayoutEffect(() => {
      if (position === 'right') return monitor(pi, witnesses, anchor.current, view);
    }, [position, view]);
    if (position !== 'right') return null;
    return h('span', { ref: anchor, className: 'acp-meter-anchor' },
      shown && h(Chip, { key: shown.epoch, pi, sample: shown.sample, lang: shown.lang }));
  }
  pi.ui.injectStyle(STYLE);
  pi.slots.register({ slot: 'entryExtra', component: SessionWitness });
  pi.slots.register({ slot: 'composerControl', positions: ['right'], component: Control });
}

const STYLE = `
.acp-meter-witness { position: absolute; width: 0; height: 0; pointer-events: none; }
.acp-meter-anchor, .acp-meter-inner { display: inline-flex; min-inline-size: 0; }
/* Decorate only our own node. A cold switch leaves the previous transcript
   mounted and readable; stock marks that surface aria-busy until commit. */
.acp-meter-anchor:where([aria-busy="true"] *) { visibility: hidden; }
.acp-meter-chip {
  display: inline-flex; align-items: center; gap: 5px; min-inline-size: 0; max-inline-size: 100%;
  block-size: 27px; padding: 0 7px; border: 1px solid var(--ds-border-default, GrayText);
  border-radius: var(--radius-sm, 6px); background: transparent;
  color: var(--ds-text-primary, CanvasText); font: inherit; font-size: 11px; line-height: 1;
  white-space: nowrap; cursor: pointer; -webkit-app-region: no-drag;
}
.acp-meter-chip:hover, .acp-meter-chip[aria-expanded="true"], .acp-meter-close:hover {
  background: var(--ds-bg-hover, color-mix(in srgb, CanvasText 10%, Canvas));
}
.acp-meter-chip:focus-visible, .acp-meter-close:focus-visible, .acp-meter-panel:focus-visible {
  outline: 2px solid var(--ds-accent, Highlight); outline-offset: -2px;
}
.acp-meter-caption, .acp-meter-value { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
.acp-meter-last { color: var(--ds-text-secondary, CanvasText); }
.acp-meter-value { font-variant-numeric: tabular-nums; font-weight: 650; flex: 0 1 auto; }
.acp-meter-short { display: none; }
@container composer-stack (max-width: 650px) {
  .acp-meter-full { display: none; }
  .acp-meter-short { display: inline; }
  .acp-meter-chip { padding-inline: 4px; gap: 3px; }
}
/* Give native controls priority. At 451–551px stock still shows model text
   and the native ring readout; at 450px it collapses those to icons, and at 360px further compacts toolbar chrome. */
@container composer-stack (width < 360px) or (450px < width < 552px) {
  .acp-meter-anchor { display: none; }
}
.acp-meter-panel {
  position: fixed; box-sizing: border-box; overflow: auto; overscroll-behavior: contain;
  padding: 12px; border: 1px solid var(--ds-border-default, GrayText); border-radius: var(--radius-md, 9px);
  background: var(--ds-bg-elevated, Canvas); color: var(--ds-text-primary, CanvasText);
  box-shadow: var(--ds-shadow-dialog, 0 8px 28px #0004);
  font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; -webkit-app-region: no-drag;
}
.acp-meter-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.acp-meter-kicker, .acp-meter-note, .acp-meter-grid dt { color: var(--ds-text-secondary, CanvasText); }
.acp-meter-kicker { font-size: 11px; }
.acp-meter-panel h2, .acp-meter-panel h3, .acp-meter-panel p, .acp-meter-grid, .acp-meter-grid dd { margin: 0; }
.acp-meter-panel h2 { font-size: 14px; font-weight: 650; }
.acp-meter-close {
  border: 0; border-radius: var(--radius-sm, 6px); background: transparent;
  color: inherit; font: inherit; font-size: 18px; line-height: 24px;
  inline-size: 24px; padding: 0; flex: 0 0 auto; cursor: pointer;
}
.acp-meter-panel .acp-meter-note { margin: 7px 0 10px; }
.acp-meter-grid { display: grid; grid-template-columns: minmax(0, 8em) minmax(0, 1fr); gap: 4px 8px; }
.acp-meter-grid dd, .acp-meter-counts, .acp-meter-ratio { font-variant-numeric: tabular-nums; }
.acp-meter-readings { display: grid; gap: 8px; margin-top: 10px; }
.acp-meter-budget, .acp-meter-raw {
  position: relative; padding: 8px; border: 1px solid var(--ds-border-subtle, GrayText);
  border-radius: var(--radius-sm, 6px);
}
.acp-meter-panel h3 { color: var(--ds-text-secondary, CanvasText); font-weight: 600; font-size: 11px; margin-bottom: 3px; }
.acp-meter-panel .acp-meter-counts, .acp-meter-ratio { display: inline; font-weight: 650; }
.acp-meter-ratio { margin-inline-start: 8px; color: var(--ds-accent, CanvasText); }
`;
