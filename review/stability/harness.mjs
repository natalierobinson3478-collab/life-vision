/* THE STABILITY HARNESS.
 *
 * Drives the published board in a headless browser and asserts the things a
 * person sees rather than the things the code says: what the browser actually
 * PAINTED, how many times a screen rendered, and where the ink ended up.
 *
 * IT NEVER TOUCHES THE LIVE BOARD. Every run opens the app with `?demo=full`,
 * which sets the storage namespace to `lvtest.demo.` before the first key is
 * read — so the four live-board keys are unreachable by construction, not by
 * a restore step that has to fire. checkNamespace() asserts that on every run
 * and fails the suite if it is ever not true.
 *
 *   node review/stability/harness.mjs            # all cases, both widths
 *   node review/stability/harness.mjs --only=companion-seat
 *   node review/stability/harness.mjs --port=8731
 *
 * A case is `{ name, widths, run(page, t) }`. `t` carries the assertions.
 * Exit code is the number of failures, so CI reads it directly.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true];
}));
// --root points the server somewhere else — a pristine checkout, say — which
// is how a case is shown red before a fix and green after without moving the
// working tree around.
const ROOT = path.resolve(argv.root ? String(argv.root)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };

/* ---- a server of our own, so a run needs nothing else standing ----
 * PORT 8731 ON PURPOSE: the page refuses to register the service worker
 * there (the gate is in the page), so the harness measures the file on disk
 * and never a copy some earlier run left in a worker's cache. */
const PORT = Number(argv.port || 8731);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((res, rej) => {
    const srv = http.createServer((req, rsp) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const f = path.join(ROOT, u === '/' ? '/index.html' : u);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); return rsp.end('not found'); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(rsp);
    });
    srv.on('error', rej);
    srv.listen(PORT, () => res(srv));
  });
}

/* ---- what the browser actually painted ----
 * The layout-shift API is the arbiter, not rAF ordering: a value that changes
 * between two animation frames may never have reached the screen, and a test
 * that fails on those reports jitter nobody can see. An entry here is a shift
 * the browser rendered. */
const INSTRUMENT = () => {
  window.__ls = [];
  window.__renders = {};
  const name = n => (n && n.nodeType === 1)
    ? n.tagName + (n.id ? '#' + n.id : '') + (n.classList && n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : '')
    : '#text';
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__ls.push({ t: +e.startTime.toFixed(0), v: +e.value.toFixed(5),
        src: (e.sources || []).map(s => `${name(s.node)} y${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)}`) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  // One render = one wholesale replacement of a mount's children.
  const watch = () => {
    // AFTER THE DOCUMENT IS PARSED, not merely after <body> opens: the mounts
    // are near the end of the file, and attaching early found none of them
    // and reported every screen as rendering zero times.
    if (document.readyState === 'loading') return document.addEventListener('DOMContentLoaded', watch, { once: true });
    document.querySelectorAll('[id$="Mount"]').forEach(m => {
      new MutationObserver(ms => ms.forEach(mu => {
        if (mu.type === 'childList' && mu.target === m && mu.addedNodes.length) {
          (window.__renders[m.id] = window.__renders[m.id] || []).push(+performance.now().toFixed(0));
        }
      })).observe(m, { childList: true });
    });
  };
  setTimeout(watch, 0);
};

const T = (name, width) => {
  const fails = [];
  const api = {
    name, width, fails,
    ok(cond, msg) { if (!cond) fails.push(msg); return !!cond; },
    eq(got, want, msg) { return api.ok(got === want, `${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); },
    atMost(got, max, msg) { return api.ok(got <= max, `${msg} — got ${got}, allowed at most ${max}`); },
  };
  return api;
};

/* ---- page helpers ---- */
const shifts = p => p.evaluate(() => { const x = window.__ls; window.__ls = []; return x; });
const cls = ls => ls.reduce((a, e) => a + e.v, 0);
const renders = p => p.evaluate(() => { const x = window.__renders; window.__renders = {}; return x; });
const openIds = p => p.evaluate(() => [...document.querySelectorAll('.book-page.open, .overlay.open')].map(o => o.id));
const closeAll = async p => {
  await p.evaluate(() => [...document.querySelectorAll('.book-page.open, .overlay.open')].forEach(o => {
    const c = o.querySelector('.checkin-close'); if (c) c.click(); else o.classList.remove('open');
  }));
  await p.waitForTimeout(700);
  await p.evaluate(() => { window.__ls = []; window.__renders = {}; });
};
const call = (p, fn) => p.evaluate(f => {
  try { const g = window.__pipeline[f]; if (!g) return 'missing'; g(); return 'ok'; }
  catch (e) { return 'throw:' + e.message.slice(0, 70); }
}, fn);

/* ---- the cases ---- */
const CASES = [];
const testCase = (name, widths, run) => CASES.push({ name, widths, run });

// The guard itself. If this ever fails, nothing else in the file may be trusted.
testCase('namespace-is-not-the-live-board', [PHONE], async (p, t) => {
  const ns = await p.evaluate(() => window.__pipeline.storage.namespace());
  t.ok(ns && ns.startsWith('lvtest.'), `the run must be namespaced, not live — namespace is ${JSON.stringify(ns)}`);
  // Read RAW key names. getItem is patched to resolve into the namespace, so
  // asking it for "lifevision.state.v1" hands back the namespaced copy and
  // would report a clean run as dirty. key()/length are not patched.
  const touched = await p.evaluate(() => {
    const live = new Set(window.__pipeline.storage.liveBoardKeys());
    const raw = [];
    for (let i = 0; i < localStorage.length; i++) raw.push(localStorage.key(i));
    return raw.filter(k => live.has(k));
  });
  t.eq(touched.length, 0, `no live board key may hold anything after a run (${touched.join(', ')})`);
});

// 1. THE COMPANION'S SEAT. The lane a companion sits in must be reserved from
//    what the board KNOWS (is there a companion?), never from whether its
//    drawing has finished arriving — or the page lays out once without the
//    lane and everything under it drops when the art lands.
testCase('companion-seat-is-reserved-before-the-art-arrives', [PHONE], async (p, t) => {
  const ls = await shifts(p);          // buffered: covers boot and the landing
  const drop = ls.filter(e => e.src.some(s => /tw-sections|tw-station|wk-wrap|wk-title|lv-station-row/.test(s)));
  t.ok(drop.length === 0, `the landing page must not move when the companion art lands — ${JSON.stringify(drop).slice(0, 300)}`);
  t.atMost(+cls(ls).toFixed(4), 0.01, 'boot + landing layout shift');
});

// 2. THE ✕ IS SEATED BEFORE THE FIRST PAINT. A page that opens with its mark
//    at the window's corner and snaps it onto the paper a frame later reads
//    as a flash. Every overlay, not only the book pages.
const SEATED = [
  ['weekly check-in', 'openWeekSheet', '#weekClose'],
  ['the art of letting go', 'openRelease', '#releaseClose'],
];
for (const [label, fn, mark] of SEATED) {
  testCase(`x-mark-does-not-jump-${fn}`, [PHONE, DESK], async (p, t) => {
    await closeAll(p);
    const r = await call(p, fn);
    if (r !== 'ok') return t.ok(false, `${label}: ${r}`);
    await p.waitForTimeout(1500);
    const ls = await shifts(p);
    const moved = ls.filter(e => e.src.some(s => s.includes(mark.slice(1))));
    t.eq(moved.length, 0, `${label}: the ✕ must be on its paper in the first painted frame — ${JSON.stringify(moved).slice(0, 220)}`);
  });
}

testCase('x-mark-does-not-jump-help-sheet', [PHONE, DESK], async (p, t) => {
  await closeAll(p);
  if (await call(p, 'openFaqPage') !== 'ok') return t.ok(false, 'facts about life would not open');
  await p.waitForTimeout(900);
  await p.evaluate(() => { window.__ls = []; });
  await p.evaluate(() => document.querySelector('#faqMount .fq-row[data-act="help"]').click());
  await p.waitForTimeout(1500);
  const moved = (await shifts(p)).filter(e => e.src.some(s => s.includes('helpClose')));
  t.eq(moved.length, 0, `how this works: the ✕ must be on its paper in the first painted frame — ${JSON.stringify(moved).slice(0, 220)}`);
});

// 3. ONE RENDER PER OPEN. A screen that renders twice on the way in shows the
//    first render for a frame, which is the "old version for a moment" shape.
const ONE_RENDER = [
  ['thisWeekMount', 'openThisWeek'], ['atlasMount', 'openAtlas'], ['chaptersMount', 'openChapters'],
  ['faqMount', 'openFaqPage'], ['tomorrowMount', 'openTomorrow'], ['portraitMount', 'openPortrait'],
  ['weekMount', 'openWeekSheet'], ['releaseMount', 'openRelease'],
];
testCase('one-render-per-screen-open', [PHONE, DESK], async (p, t) => {
  for (const [mount, fn] of ONE_RENDER) {
    await closeAll(p);
    const r = await call(p, fn);
    if (r !== 'ok') { t.ok(false, `${fn}: ${r}`); continue; }
    await p.waitForTimeout(1400);
    const n = ((await renders(p))[mount] || []).length;
    t.eq(n, 1, `${fn} must fill ${mount} exactly once`);
  }
});

// 4. NO SCREEN MAY SHIFT WHAT IT HAS ALREADY PAINTED. The sweep, as one case.
testCase('no-screen-shifts-after-it-opens', [PHONE, DESK], async (p, t) => {
  for (const [, fn] of ONE_RENDER) {
    await closeAll(p);
    if (await call(p, fn) !== 'ok') continue;
    await p.waitForTimeout(1500);
    const ls = await shifts(p);
    t.atMost(+cls(ls).toFixed(4), 0.005, `${fn}: layout shift after open (${ls.map(e => e.src.join('|')).join(' ;; ').slice(0, 220)})`);
  }
});

// 5. THE SPOTLIGHT DOES NOT FLY IN FROM THE CORNER. The tour's hole carries a
//    transition on its geometry; if it is inserted at 0,0 and placed after,
//    the transition plays on first paint and the dimmed page sweeps in.
testCase('tour-spotlight-does-not-animate-in-from-0,0', [PHONE, DESK], async (p, t) => {
  await closeAll(p);
  const seen = await p.evaluate(async () => {
    document.querySelectorAll('#walkOverlay').forEach(x => x.remove());
    const frames = [];
    const sample = () => {
      const h = document.querySelector('#walkOverlay .walk-hole');
      if (!h) return;
      const r = h.getBoundingClientRect();
      frames.push({ w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top),
        shown: getComputedStyle(h).visibility !== 'hidden' });
    };
    window.__pipeline.replayShelfTour();
    for (let i = 0; i < 90; i++) { await new Promise(r => requestAnimationFrame(r)); sample(); }
    document.querySelectorAll('#walkOverlay').forEach(x => x.remove());
    return frames;
  });
  if (!seen.length) return;                       // no tour on this board; nothing to prove
  // A hole with no size is not a spotlight — its dimming spreads from its own
  // box, so a zero-size hole shown on screen is the whole page going dark with
  // nothing lit. And a hole shown at the corner it was inserted at, before
  // anything placed it there, is the transition playing on first paint.
  const empty = seen.filter(f => f.shown && (f.w === 0 || f.h === 0));
  t.eq(empty.length, 0, `the spotlight must not be shown before it is placed (${empty.length} of ${seen.length} frames)`);
  const shown = seen.filter(f => f.shown);
  const corner = shown.filter(f => f.x <= 0 && f.y <= 0);
  t.eq(corner.length, 0, `the spotlight must not be shown at the corner it was inserted at (${corner.length} of ${shown.length} shown frames)`);
});

// 6. NOTHING IS SIZED BY THE LARGE VIEWPORT. `vh` on a phone is the window
//    with the browser's toolbar RETRACTED, so a page sized in vh is exactly
//    the toolbar's height taller than what the reader can see — and a page
//    whose only reason to scroll is the toolbar is the page that shakes at
//    the foot of a scroll. This one is a SOURCE assertion on purpose: a
//    headless browser has no toolbar, so vh, svh and dvh all resolve to the
//    same number and no measurement here can tell them apart. What is being
//    held is the rule, and it is the rule that was wrong.
testCase('no-page-is-sized-by-the-large-viewport', [PHONE], async (p, t) => {
  const src = fs.readFileSync(path.join(ROOT, 'life-vision-board.html'), 'utf8');
  const css = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));
  // min-height / height declarations in vh that decide whether a page scrolls.
  const bad = [];
  for (const m of css.matchAll(/(^|[;{])\s*(min-height|height)\s*:\s*([^;}]*\d+vh[^;}]*)/gm)) {
    const decl = `${m[2]}: ${m[3].trim()}`;
    const line = css.slice(0, m.index).split('\n').length;
    // A declaration immediately followed by an svh (or dvh) one of the same
    // property is the fallback pair, which is exactly right.
    const after = css.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (new RegExp(`^\\s*;\\s*${m[2]}\\s*:\\s*[^;}]*\\d+(s|d)vh`).test(after)) continue;
    bad.push(`${decl} (style line ${line})`);
  }
  // .paper-canvas is fixed and paints from window.innerWidth/innerHeight; it
  // creates no overflow and decides nothing about scrolling.
  const real = bad.filter(b => !/103vh/.test(b));
  t.eq(real.length, 0, `a page sized in vh will shake at the foot of a phone scroll — ${real.join(', ')}`);
  // and the empty board must still fit its window exactly
  const fits = await p.evaluate(() => {
    [...document.querySelectorAll('.book-page.open, .overlay.open')].forEach(o => o.classList.remove('open'));
    const g = window.__pipeline.goalsGet(); g.length = 0;
    window.__pipeline.renderAll();
    return new Promise(r => setTimeout(() => r({
      empty: document.body.classList.contains('empty-board'),
      over: document.scrollingElement.scrollHeight - window.innerHeight,
    }), 800));
  });
  t.ok(fits.empty, 'the forced board should be the empty one');
  t.atMost(fits.over, 0, 'the empty board must not overflow its window');
});

/* ---- runner ---- */
const only = argv.only ? String(argv.only) : null;
const srv = await serve();
const browser = await chromium.launch();
let failed = 0, ran = 0;
const URL = `http://127.0.0.1:${PORT}/life-vision-board.html?demo=full`;

for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  for (const vp of c.widths) {
    const t = T(c.name, vp.width);
    const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 500, isMobile: vp.width < 500 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(INSTRUMENT);
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    try { await c.run(page, t); } catch (e) { t.fails.push('threw: ' + e.message); }
    if (errs.length) t.fails.push('page errors: ' + errs.slice(0, 2).join(' | ').slice(0, 200));
    ran++;
    if (t.fails.length) { failed++; console.log(`FAIL  ${c.name} @${vp.width}`); t.fails.forEach(f => console.log(`        ${f}`)); }
    else console.log(`pass  ${c.name} @${vp.width}`);
    await ctx.close();
  }
}
await browser.close();
srv.close();
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed);
