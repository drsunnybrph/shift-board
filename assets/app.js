import { DEMO } from './demo-data.js';
import { Schedule, findCoverage, DEFAULT_RULES, LEAVE_CODES } from './engine.js';
import { readFile } from './parser.js';
import { planRequests, reconcile, makeWholePlans, requestableOn,
         loadAvailability, saveAvailability, openShifts,
         freeDays, summarise, planKey } from './request.js';

const MONTH = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOWFULL = { Su:'Sunday', M:'Monday', T:'Tuesday', W:'Wednesday', Th:'Thursday', F:'Friday', Fr:'Friday', Sa:'Saturday' };
const STORE = 'shiftboard.v1';

const state = {
  sched: null,
  me: null,
  tab: 'board',
  posts: [],
  rules: { ...DEFAULT_RULES },
  savedModel: null,
  pending: null,
  avail: new Set(),
  wantMode: 'days',
  picks: new Set(),
  chosen: new Map(),
  wantsOff: new Set()
};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

/* ---------- persistence ----------
 * localStorage only. This is per-device and per-browser: it is NOT a shared
 * board. Two people opening the same URL get two separate copies of
 * everything. Making this multiplayer needs a backend — see README.
 *
 * A parsed schedule is kept here so you don't re-upload on every visit. It
 * stays in your own browser and is never transmitted. Setup → Forget clears it.
 */
async function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.posts = saved.posts || [];
    state.rules = { ...DEFAULT_RULES, ...(saved.rules || {}) };
    if (saved.model) state.savedModel = saved.model;
    if (saved.me) state.me = saved.me;
  } catch { /* corrupt or unavailable — carry on with defaults */ }
}
async function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      posts: state.posts,
      rules: state.rules,
      me: state.me,
      model: state.sched && state.sched.meta.source === 'uploaded' ? state.sched.raw : null
    }));
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') toast('Schedule too large to remember on this device');
  }
}
function forget() {
  try { localStorage.removeItem(STORE); } catch {}
}

/* ---------- small builders ---------- */
function dateBlock(i) {
  const d = state.sched.dates[i];
  return `<div class="dt"><div class="dow">${d.dow}</div><div class="num">${d.d}</div>
          <div class="mo">${MONTH[d.m]}</div></div>`;
}

function runBar(person, idx, adding) {
  const s = state.sched;
  const probe = adding ? { ...person, shifts: { ...person.shifts, [String(idx)]: 'X' } } : person;
  const r = s.runThrough(probe, idx);
  let h = '<div class="runbar">';
  for (let i = r.start; i <= r.end; i++) {
    h += `<div class="rb ${i === idx ? (adding ? 'new' : 'self') : 'on'}"></div>`;
  }
  h += `<span class="rblab${r.length >= state.rules.longRunDays ? ' warn' : ''}">${r.length} days straight</span></div>`;
  return h;
}

function postTags(post, covers) {
  let t = '';
  if (post.kind === 'sick') t += '<span class="tag u">Sick call</span>';
  if (post.kind === 'swap') t += '<span class="tag b">Wants a trade</span>';
  if (post.takenBy) {
    t += `<span class="tag g">${esc(post.takenBy)} picked it up</span>`;
  } else {
    const clean = covers.filter(c => !c.unsafe && !c.costly).length;
    const withOt = covers.filter(c => !c.unsafe && c.costly).length;
    t += `<span class="tag">${clean} can cover</span>`;
    if (withOt) t += `<span class="tag a">${withOt} more with OT</span>`;
  }
  if (!post.takenBy && post.by === state.me) t += '<span class="tag b">Your post</span>';
  return t;
}

function postCard(post) {
  const s = state.sched;
  const person = s.person(post.by);
  const pos = s.position(post.code);
  const covers = post.takenBy ? [] : findCoverage(s, post.idx, post.code, post.by, state.rules);
  return `<div class="card${post.kind === 'sick' ? ' urg' : ''}${post.takenBy ? ' done' : ''}">
    <button class="ctop" data-open="${post.id}">
      ${dateBlock(post.idx)}
      <div class="cbody">
        <div class="line1"><span class="code">${esc(post.code)}</span>
          <span class="time mono">${pos ? esc(pos.time) : ''}</span></div>
        <div class="who"><b>${esc(post.by)}</b> can&rsquo;t work this</div>
        ${post.note ? `<div class="note">&ldquo;${esc(post.note)}&rdquo;</div>` : ''}
        <div class="tagrow">${postTags(post, covers)}</div>
        ${person ? runBar(person, post.idx, false) : ''}
      </div>
      <div class="chev">&rsaquo;</div>
    </button></div>`;
}

/* ---------- views ---------- */
function viewBoard() {
  const open = state.posts.filter(p => !p.takenBy);
  const done = state.posts.filter(p => p.takenBy);
  $('ctBoard').textContent = open.length;

  const sick = open.filter(p => p.kind === 'sick').sort((a, b) => a.idx - b.idx);
  const rest = open.filter(p => p.kind !== 'sick').sort((a, b) => a.idx - b.idx);

  let h = '';
  if (sick.length) h += `<div class="eyebrow"><span>Needs coverage now</span></div>` + sick.map(postCard).join('');
  h += `<div class="eyebrow"><span>Up for grabs</span><span class="mono">${rest.length}</span></div>`;
  h += rest.length ? rest.map(postCard).join('')
    : `<div class="empty"><div class="big">Nothing on the board</div>
       Post a shift you can&rsquo;t work and the board will rank who can actually take it.</div>`;
  if (done.length) {
    h += `<div class="eyebrow"><span>Covered &mdash; pending manager sign-off</span></div>`;
    h += done.sort((a, b) => a.idx - b.idx).map(postCard).join('');
  }
  h += `<div class="disc">Nothing here changes the real schedule. Every swap still needs manager
        approval and whatever form your department uses.</div>`;
  return h;
}

function viewPost() {
  const s = state.sched, p = s.person(state.me);
  if (!p) return `<div class="empty"><div class="big">Pick your name up top</div>Then your shifts show here.</div>`;
  const already = new Set(state.posts.filter(x => x.by === state.me && !x.takenBy).map(x => x.idx));
  let rows = '';
  for (let i = 0; i < s.n; i++) {
    if (!s.worksOn(p, i)) continue;
    const code = s.cell(p, i), pos = s.position(code);
    const on = already.has(i);
    rows += `<div class="card"><button class="ctop" data-post="${i}" ${on ? 'disabled' : ''}>
      ${dateBlock(i)}
      <div class="cbody"><div class="line1"><span class="code">${esc(code)}</span>
        <span class="time mono">${pos ? esc(pos.time) : ''}</span></div>
        <div class="who">${on ? 'Already on the board' : 'Tap to put this up'}</div>
        ${runBar(p, i, false)}</div>
      ${on ? '' : '<div class="chev">&rsaquo;</div>'}</button></div>`;
  }
  return `<div class="eyebrow"><span>Your shifts &mdash; pick one to give up</span></div>` +
    (rows || `<div class="empty"><div class="big">No shifts scheduled</div>Nothing to post this period.</div>`);
}

function viewMine() {
  const s = state.sched, p = s.person(state.me);
  if (!p) return `<div class="empty"><div class="big">Pick your name up top</div></div>`;
  let h = '';
  const picked = state.posts.filter(x => x.takenBy === state.me);
  if (picked.length) h += `<div class="eyebrow"><span>You picked up</span></div>` + picked.map(postCard).join('');
  h += `<div class="eyebrow"><span>Your schedule</span><span class="mono">${s.totalShifts(p)} shifts</span></div>`;
  for (let w = 0; w < s.n; w += 7) {
    const end = Math.min(w + 6, s.n - 1);
    const hrs = s.weeklyHours(p, w);
    const over = hrs > state.rules.weeklyOvertimeHours;
    h += `<div class="wk"><div class="wklab"><span>${s.dateLabel(w)} &ndash; ${s.dateLabel(end)}</span>
      <span${over ? ' style="color:var(--amber)"' : ''}>${hrs} hrs</span></div><div class="wkgrid">`;
    for (let i = w; i <= end; i++) {
      const d = s.dates[i], v = s.cell(p, i);
      let cls = 'cell off', txt = '&middot;';
      if (s.isWork(v)) { cls = 'cell on'; txt = esc(v); }
      else if (v && LEAVE_CODES.has(v)) { cls = 'cell leave'; txt = esc(v.toUpperCase()); }
      h += `<div class="${cls}"><div class="cd">${d.dow} ${d.d}</div><div class="cc">${txt}</div></div>`;
    }
    h += '</div></div>';
  }
  return h;
}

function viewGaps() {
  const s = state.sched;
  const gaps = s.gaps();
  if (!gaps.length) {
    return `<div class="empty"><div class="big">Every required position is filled</div>
      Gaps show up here when a required slot has nobody assigned.</div>`;
  }
  const byDay = {};
  for (const g of gaps) (byDay[g.day] ||= []).push(g.code);
  let h = `<div class="eyebrow"><span>Unfilled required positions</span><span class="mono">${gaps.length}</span></div>`;
  for (const day of Object.keys(byDay).sort((a, b) => a - b)) {
    const codes = byDay[day];
    h += `<div class="card"><div class="ctop">${dateBlock(+day)}
      <div class="cbody"><div class="line1">${codes.map(c => `<span class="code">${esc(c)}</span>`).join('')}</div>
      <div class="who">${codes.length} position${codes.length > 1 ? 's' : ''} with nobody assigned</div>
      <div class="tagrow">${codes.map(c =>
        `<button class="tag b" data-gap="${day}:${c}">Who can cover ${esc(c)}</button>`).join('')}</div>
      </div></div></div>`;
  }
  return h;
}

function viewSetup() {
  const s = state.sched;
  const r = state.rules;
  const loaded = s.meta.source === 'uploaded';

  const sw = (key, on, label, hint) => `<div class="row"><div><div class="lbl">${label}</div>
    <div class="hint">${hint}</div></div>
    <button class="switch" role="switch" aria-checked="${on}" data-rule="${key}"></button></div>`;
  const num = (key, val, label, hint) => `<div class="row"><div><div class="lbl">${label}</div>
    <div class="hint">${hint}</div></div>
    <input type="number" data-num="${key}" value="${val}" min="0" step="0.5"></div>`;

  const status = loaded
    ? `<div class="card ok-card"><div class="row"><div>
         <div class="lbl">&#10003; Your schedule is loaded</div>
         <div class="hint">${esc(s.meta.label || 'Loaded schedule')} &mdash; ${s.staff.length} people,
           ${s.n} days, ${s.positions.length} positions. Saved in this browser, so you won&rsquo;t
           need to load it again on this device.</div></div>
         <button class="btn o sm" data-act="reset">Remove</button></div></div>`
    : '';

  return `${status}
  <div class="eyebrow"><span>${loaded ? 'Replace it' : 'Step 1 &mdash; load your schedule'}</span></div>

  <div class="drop" id="drop">
    <div class="big">Drop your schedule file here</div>
    <p>Excel file &mdash; .xlsx, .xls, or .xlsm</p>
    <button class="btn p" data-act="pick">Choose a file</button>
    <input type="file" id="file" accept=".xlsx,.xls,.xlsm" hidden>
  </div>
  <div id="parseErr"></div>

  <div class="card safe"><div class="safe-in">
    <div class="lbl">Your file never leaves this device</div>
    <div class="hint">There is no server to send it to. The file is opened and read inside your
      browser, and what it reads is kept in this browser only. Nothing is uploaded, nothing is
      shared, and no one else can see it &mdash; including whoever built this.</div>
  </div></div>

  <div class="eyebrow"><span>On a phone</span></div>
  <div class="card"><div class="steps">
    <div class="step"><span class="sn">1</span><div>Open the email or message with the schedule
      attached. Tap the attachment, then <b>Save to Files</b>.</div></div>
    <div class="step"><span class="sn">2</span><div>Come back here, tap <b>Choose a file</b>, and
      pick it from Files.</div></div>
    <div class="step"><span class="sn">3</span><div>Choose your name from the picker at the top
      right. That&rsquo;s it.</div></div>
    <div class="step"><span class="sn">4</span><div>Optional &mdash; use your browser&rsquo;s share
      menu and <b>Add to Home Screen</b> so it opens like an app.</div></div>
  </div></div>

  <div class="eyebrow"><span>What the file needs to look like</span></div>
  <div class="card"><div class="fmt">
    <div class="fmt-grid mono">
      <div class="fh"></div><div class="fh">Su</div><div class="fh">M</div><div class="fh">T</div><div class="fh">W</div><div class="fh">Th</div>
      <div class="fh"></div><div class="fh">16</div><div class="fh">17</div><div class="fh">18</div><div class="fh">19</div><div class="fh">20</div>
      <div class="fn">A. Chen</div><div class="fc on">ED</div><div class="fc on">ED</div><div class="fc"></div><div class="fc on">ICU</div><div class="fc lv">PTO</div>
      <div class="fn">R. Patel</div><div class="fc"></div><div class="fc on">C1</div><div class="fc on">C1</div><div class="fc on">C1</div><div class="fc"></div>
    </div>
    <div class="hint" style="margin-top:10px">Names down the first column. Day-of-week and dates
      across the top. Shift codes in the cells. Most hand-built hospital schedules already look
      like this &mdash; you probably don&rsquo;t need to change anything.</div>
    <div class="hint" style="margin-top:8px"><b>One thing it does need:</b> a legend somewhere in the
      sheet pairing each code with its hours, like <span class="mono">ED&nbsp;&nbsp;1430-0100</span>.
      Without it the tool can&rsquo;t work out rest between shifts, and it will tell you so rather
      than guess.</div>
    <div class="hint" style="margin-top:8px">Optional: a second sheet named Check, Staffing, or
      Coverage marking which positions are required each day fills in the Gaps tab.</div>
  </div></div>

  <div class="eyebrow"><span>Overtime and rest rules</span></div>
  <div class="card">
    ${num('minTurnaroundHours', r.minTurnaroundHours, 'Minimum hours between shifts',
          'Below this is flagged as a rest problem, not a cost one')}
    ${num('weeklyOvertimeHours', r.weeklyOvertimeHours, 'Weekly overtime threshold',
          'Hours in a pay week before overtime applies')}
    ${num('longRunDays', r.longRunDays, 'Long run threshold',
          'Consecutive days before a stretch reads as heavy')}
    ${sw('alternativeWorkweek', r.alternativeWorkweek, 'Alternative workweek in effect',
         'On: 10s and 12s are straight time. Off: daily overtime past 8 hours')}
    ${sw('seventhDayPremium', r.seventhDayPremium, 'Seventh-day premium',
         'Flag the 7th consecutive day worked in a pay week')}
    ${num('dailyStraightTimeCap', r.dailyStraightTimeCap, 'Double-time threshold',
          'Hours in one day before double time applies')}
    ${num('noticeDays', r.noticeDays, 'Minimum swap notice (days)',
          'Set to 0 to turn off. Flags swaps posted inside your policy window')}
  </div>
  <div class="card"><div class="row"><div>
    <div class="lbl">These are not your employer&rsquo;s rules</div>
    <div class="hint">They&rsquo;re a generic starting point leaning toward California. Union terms,
      seniority order on open shifts, break premiums, per diem minimums, and competency sign-off
      are not modelled at all. Confirm anything here against your actual policy before treating a
      flag as authoritative.</div>
  </div></div></div>

  <div class="eyebrow"><span>What this does and doesn&rsquo;t do</span></div>
  <div class="card"><div class="row"><div>
    <div class="lbl">This board is yours alone</div>
    <div class="hint">Everything lives in this browser on this device. Someone else opening the
      same link gets their own separate copy &mdash; they will not see what you post, and you will
      not see theirs. A genuinely shared board needs a server.</div>
  </div></div></div>
  <div class="disc">Flags are informational. Coverage comes first &mdash; the board will always show
    who can work a shift, and marks what it costs. Your payroll and HR rules govern, not this tool.</div>`;
}

function onDemo() {
  return !state.sched || state.sched.meta.source !== 'uploaded';
}

/* Persistent until a real schedule is loaded. Not dismissible on purpose —
   someone should never mistake the sample department for their own. */
function demoBanner() {
  if (!onDemo()) return '';
  return `<div class="demo">
    <div class="demo-tag">Sample data</div>
    <div class="demo-body">
      <b>This is an invented department.</b> Twenty-five made-up people on a made-up rotation
      &mdash; here so you can click around and see how it works before trusting it with anything real.
      <button class="btn p sm demo-cta" data-tab="setup">Load your schedule</button>
    </div>
  </div>`;
}


/* ============================================================
   "I want this shift" — the per diem direction
   ============================================================ */

/* Every tap re-renders, and the planner is the expensive part of a render.
   Nothing about the plans changes when you merely select a card, so the result
   is cached against the inputs that actually affect it. */
let _planCache = { key: null, value: null };
function cachedPlans() {
  const s = state.sched, me = s.person(state.me);
  if (!me) return [];
  const key = [
    state.me,
    [...state.avail].sort((a, b) => a - b).join(','),
    state.posts.filter(p => !p.takenBy).map(p => `${p.by}:${p.idx}`).join('|'),
    [...state.wantsOff].sort().join(','),
    JSON.stringify(state.rules)
  ].join('##');
  if (_planCache.key === key) return _planCache.value;
  _planCache = { key, value: planRequests(s, me, state.avail, state.rules, state.posts, state.wantsOff) };
  return _planCache.value;
}
function invalidatePlans() { _planCache = { key: null, value: null }; }

function planBadge(p) {
  if (!p) return '<span class="tag u">No workable plan</span>';
  if (p.kind === 'open')   return '<span class="tag g">Unfilled &mdash; nobody loses hours</span>';
  if (p.kind === 'swap')   return '<span class="tag g">Even trade available</span>';
  if (p.kind === 'pickup') return '<span class="tag g">They pick up an open shift</span>';
  if (p.kind === 'relay') {
    if (p.via && p.via.posted)   return `<span class="tag g">${esc(p.third)} covers a posted shift</span>`;
    if (p.via && p.via.takesPto) return `<span class="tag g">${esc(p.third)} takes the PTO day</span>`;
    return `<span class="tag b">Three-way via ${esc(p.third)}</span>`;
  }
  if (p.kind === 'pto')    return '<span class="tag a">Costs them PTO</span>';
  return '';
}

function stepBar(active) {
  const steps = [['days', 'Your days'], ['browse', 'Pick shifts'], ['plan', 'The plan']];
  return `<div class="steps-bar">${steps.map(([k, label], i) =>
    `<button class="stepb${k === active ? ' on' : ''}" data-step="${k}">
      <span class="sb-n">${i + 1}</span>${label}</button>`).join('')}</div>`;
}

function viewWant() {
  const s = state.sched, me = s.person(state.me);
  if (!me) return `<div class="empty"><div class="big">Pick your name up top</div></div>`;

  /* ---------- step 1: which days ---------- */
  if (state.wantMode === 'days') {
    const free = freeDays(s, me);
    const declaredDays = s.declaredAvailable(me);
    let grid = '';
    for (let w = 0; w < s.n; w += 7) {
      const end = Math.min(w + 6, s.n - 1);
      grid += `<div class="wk"><div class="wklab">
          <span>${s.dateLabel(w)} &ndash; ${s.dateLabel(end)}</span>
          <button class="minib" data-week="${w}">All free</button></div>
        <div class="wkgrid">`;
      for (let i = w; i <= end; i++) {
        const d = s.dates[i], v = s.cell(me, i);
        const working = s.isWork(v);
        const leave = v && !working && v !== 'x';
        const blocked = working || leave;
        const on = state.avail.has(i);
        const marked = declaredDays ? declaredDays.includes(i) : false;
        grid += `<button class="cell av${on ? ' picked' : ''}${blocked ? ' busy' : ''}${
              marked && !on && !blocked ? ' marked' : ''}"
            data-avail="${i}" ${blocked ? 'disabled' : ''}>
          <div class="cd">${d.dow} ${d.d}</div>
          <div class="cc">${blocked ? esc(v) : on ? '\u2713' : ''}</div></button>`;
      }
      grid += '</div></div>';
    }
    const declared = s.declaredAvailable(me);
    const intro = declared
      ? `<div class="card ok-card"><div class="safe-in">
           <div class="lbl">&#10003; Read from your schedule</div>
           <div class="hint">This sheet marks availability by cell colour, and yours is filled in
             below. Change anything that&rsquo;s out of date &mdash; what you set here wins.</div>
         </div></div>`
      : `<div class="card"><div class="safe-in">
           <div class="lbl">${free.length} days you aren&rsquo;t scheduled</div>
           <div class="hint">Not being scheduled isn&rsquo;t the same as being free, so nothing is
             selected for you. Tap the days you could actually work, or use the shortcuts.</div>
         </div></div>`;

    return stepBar('days') + intro + `
      <div class="bulk">
        <button class="btn o sm" data-act="allfree">${
          declared ? `All ${free.length} marked` : `Select all ${free.length}`}</button>
        <button class="btn o sm" data-act="weekends">Weekends only</button>
        <button class="btn o sm" data-act="clearavail">Clear</button>
      </div>
      <div class="eyebrow"><span>Your availability</span>
        <span class="mono">${state.avail.size} selected</span></div>
      ${grid}
      <button class="btn p" data-step="browse" ${state.avail.size ? '' : 'disabled'}>
        ${state.avail.size ? `See what&rsquo;s available on ${state.avail.size} day${state.avail.size > 1 ? 's' : ''}` : 'Pick at least one day'}
      </button>
      <div class="disc">Saved on this device only.</div>`;
  }

  /* ---------- step 2: pick shifts ---------- */
  if (state.wantMode === 'browse') {
    const all = cachedPlans();
    if (!all.length) {
      return stepBar('browse') +
        `<div class="empty"><div class="big">Nothing available on those days</div>
          Every position is filled by someone who can&rsquo;t be made whole, or would leave you
          without enough rest between shifts.</div>
        <button class="btn o" data-step="days">Change your days</button>`;
    }
    const byDay = {};
    for (const r of all) (byDay[r.day] ||= []).push(r);

    let h = stepBar('browse') +
      `<div class="eyebrow"><span>Tap the shifts you want</span>
        <span class="mono">${state.picks.size} selected</span></div>`;

    for (const day of Object.keys(byDay).sort((a, b) => a - b)) {
      h += `<div class="daygroup"><div class="dayhead">${s.dateLabel(+day)} &middot;
        ${DOWFULL[s.dates[+day].dow] || s.dates[+day].dow}</div>`;
      const dayPicked = [...state.picks].some(k => +k.split(':')[0] === +day);
      for (const r of byDay[day].slice(0, 8)) {
        const key = `${r.day}:${r.code}`;
        const on = state.picks.has(key);
        const blocked = dayPicked && !on;
        const pos = s.position(r.code);
        h += `<div class="card pickcard${on ? ' picked' : ''}${blocked ? ' blocked' : ''}">
          <button class="ctop" data-pick="${key}" ${blocked ? 'disabled' : ''}>
            <div class="tick">${on ? '\u2713' : ''}</div>
            <div class="cbody">
              <div class="line1"><span class="code">${esc(r.code)}</span>
                <span class="time mono">${pos ? esc(pos.time) : ''}</span></div>
              <div class="who">${r.open ? '<b>Unfilled</b>' : `Held by <b>${esc(r.holder.name)}</b>`}</div>
              <div class="tagrow">${blocked
                ? '<span class="tag">You already picked a shift this day</span>'
                : planBadge(r.best)}</div>
            </div>
          </button>
          <button class="why" data-want="${key}">How it works &rsaquo;</button>
        </div>`;
      }
      h += '</div>';
    }
    h += `<button class="btn p" data-step="plan" ${state.picks.size ? '' : 'disabled'}>
      ${state.picks.size ? `Build the plan (${state.picks.size} shift${state.picks.size > 1 ? 's' : ''})` : 'Select at least one shift'}
    </button>`;
    return h;
  }

  /* ---------- step 3: the assembled plan ---------- */
  const all = cachedPlans();
  const chosen = all.filter(r => state.picks.has(`${r.day}:${r.code}`))
                    .sort((a, b) => a.day - b.day);
  const rec = reconcile(chosen, state.chosen);
  const sum = summarise(s, rec);
  const stuck = rec.filter(r => !r.best);

  let h = stepBar('plan') +
    `<div class="card totals"><div class="tgrid">
      <div><div class="tnum">${sum.netHours > 0 ? '+' : ''}${sum.netHours}</div>
        <div class="tlab">net hours</div></div>
      <div><div class="tnum">${rec.length}</div><div class="tlab">shifts</div></div>
      <div><div class="tnum">${sum.people.length}</div><div class="tlab">to ask</div></div>
    </div>
    <div class="tnote">You pick up ${sum.gained} hrs${sum.givenBack ? `, give back ${sum.givenBack} hrs` : ''}${
      sum.openFilled ? `, and ${sum.openFilled} unfilled position${sum.openFilled > 1 ? 's get' : ' gets'} covered` : ''}.</div>
    </div>`;

  if (stuck.length) {
    h += `<div class="card urg"><div class="plan">
      <div class="cname">${stuck.length} shift${stuck.length > 1 ? 's have' : ' has'} no workable plan</div>
      <div class="plandet">${stuck.map(r =>
        `${s.dateLabel(r.day)} ${esc(r.code)} &mdash; ${esc(r.conflictReason || 'no workable plan')}`
      ).join('<br>')}</div>
    </div></div>`;
  }

  h += `<div class="eyebrow"><span>Who to ask, and what they get</span></div>`;

  for (const p of sum.people) {
    h += `<div class="card"><div class="plan">
      <div class="cname">${esc(p.name)}</div>
      <div class="reasons" style="margin-top:7px">
        ${p.gives.map(g => `<div class="rsn"><i>&minus;</i>Gives ${g.to ? esc(g.to) : 'you'} ${s.dateLabel(g.day)} ${esc(g.code)}</div>`).join('')}
        ${p.takes.map(t => `<div class="rsn ok"><i>+</i>Takes ${
          t.from === 'open' ? 'the open' : t.from === 'you' ? 'your' : esc(t.from) + '\u2019s'
        } ${s.dateLabel(t.day)} ${esc(t.code)}</div>`).join('')}
        ${p.pto ? (p.wantsIt
          ? `<div class="rsn ok"><i>&#10003;</i>Takes ${p.pto} hrs of PTO &mdash; the time off they wanted</div>`
          : `<div class="rsn cost"><i>$</i>Uses ${p.pto} hrs of PTO</div>`) : ''}
      </div>
    </div></div>`;
  }

  const openOnly = rec.filter(r => r.best && r.best.kind === 'open');
  if (openOnly.length) {
    h += `<div class="card ok-card"><div class="plan">
      <div class="cname">&#10003; Nobody to ask for ${openOnly.length} of these</div>
      <div class="plandet">${openOnly.map(r => `${s.dateLabel(r.day)} ${r.code}`).join(', ')}
        ${openOnly.length > 1 ? 'are' : 'is'} unfilled. Manager approval only.</div>
    </div></div>`;
  }

  h += `<button class="btn p" data-act="copygroup">Copy a message for the group chat</button>
    <button class="btn o" data-act="copyplan">Copy the version for your manager</button>
    <button class="btn o" data-step="browse">Change what you picked</button>
    <div class="disc">Nothing here is agreed. Every swap needs the people involved to say yes and
      your manager to approve it.</div>`;
  return h;
}

function firstName(n) { return String(n).split(/[\s,]+/)[0]; }

/**
 * Two audiences, two registers. The summary is for a manager or a swap form:
 * dates, codes, and the coverage assurance. The group message is for the
 * people whose shifts are moving, and it has to open with what each of them
 * gets, because that is the part they will decide on.
 */
function planText(style = 'summary') {
  const s = state.sched, me = s.person(state.me);
  const rec = reconcile(cachedPlans().filter(r => state.picks.has(`${r.day}:${r.code}`))
                                     .sort((a, b) => a.day - b.day), state.chosen);
  const sum = summarise(s, rec);
  const L = [];

  if (style === 'group') {
    const names = sum.people.map(p => firstName(p.name));
    const greeting = names.length === 0 ? 'Hey'
      : names.length === 1 ? `Hey ${names[0]}`
      : `Hey ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    L.push(`${greeting} \u2014 trying to sort out some shifts and I think this works for everyone.`);
    L.push('');

    for (const p of sum.people) {
      const fn = firstName(p.name);
      const bits = [];
      if (p.gives.length) bits.push(`you'd hand off ${p.gives.map(g => `${s.dateLabel(g.day)} ${g.code}`).join(' and ')}`);
      const fromOthers = p.takes.filter(t => t.from !== 'open' && t.from !== 'you');
      const fromMe = p.takes.filter(t => t.from === 'you');
      const fromOpen = p.takes.filter(t => t.from === 'open');
      if (fromMe.length)     bits.push(`you'd pick up my ${fromMe.map(t => `${s.dateLabel(t.day)} ${t.code}`).join(' and ')}`);
      if (fromOthers.length) bits.push(`you'd cover ${fromOthers.map(t => `${firstName(t.from)}'s ${s.dateLabel(t.day)} ${t.code}`).join(' and ')}`);
      if (fromOpen.length)   bits.push(`you'd pick up the open ${fromOpen.map(t => `${s.dateLabel(t.day)} ${t.code}`).join(' and ')}`);
      if (p.pto)             bits.push(p.wantsIt
        ? `you'd take ${p.pto} hrs of PTO \u2014 the time off you were after`
        : `you'd use ${p.pto} hrs of PTO`);

      const net = p.takes.reduce((t, x) => t + s.hoursOf(x.code), 0)
                - p.gives.reduce((t, x) => t + s.hoursOf(x.code), 0);
      const tail = p.pto ? ''
        : net === 0 ? ' \u2014 so your hours come out the same'
        : net > 0 ? ` \u2014 so you'd be up ${Math.round(net * 10) / 10} hrs`
        : ` \u2014 that's ${Math.abs(Math.round(net * 10) / 10)} hrs less, so only if the time off works for you`;

      L.push(`${fn}: ${bits.join(', ')}${tail}.`);
    }

    L.push('');
    const mine = rec.filter(r => r.best).map(r => `${s.dateLabel(r.day)} ${r.code}`);
    if (mine.length) L.push(`I'd pick up ${mine.join(', ')}.`);
    L.push('Nothing changes coverage \u2014 every shift still has someone on it.');
    L.push('');
    L.push('Let me know if this works for you and I\u2019ll put in the swap request.');
    return L.join('\n');
  }

  L.push(`Shift swap proposal \u2014 ${s.dateLabel(0)} to ${s.dateLabel(s.n - 1)}`);
  L.push('');
  for (const r of rec) {
    if (!r.best) { L.push(`${s.dateLabel(r.day)} ${r.code} \u2014 no workable plan`); continue; }
    if (r.best.kind === 'open') { L.push(`${s.dateLabel(r.day)} ${r.code} \u2014 unfilled, manager approval only`); continue; }
    if (r.best.kind === 'relay') {
      L.push(`${s.dateLabel(r.day)} ${r.code} \u2014 from ${r.holder.name}, who covers ${r.best.via.person}\u2019s ${s.dateLabel(r.best.via.day)} ${r.best.via.code} instead`);
    } else {
      L.push(`${s.dateLabel(r.day)} ${r.code} \u2014 from ${r.holder.name}: ${r.best.title.replace(/^They /, '')}`);
    }
  }
  L.push('');
  L.push(`Net for me: ${sum.netHours > 0 ? '+' : ''}${sum.netHours} hrs across ${rec.length} shifts.`);
  if (sum.ptoSpent) L.push(`PTO used: ${sum.ptoSpent} hrs.`);
  if (sum.openFilled) L.push(`${sum.openFilled} unfilled position${sum.openFilled > 1 ? 's get' : ' gets'} covered.`);
  L.push('No required position goes uncovered under this plan.');
  return L.join('\n');
}

function openWant(dayIdx, code) {
  state.openWantArgs = [dayIdx, code];
  const s = state.sched, me = s.person(state.me);
  const d = s.dates[dayIdx], pos = s.position(code);
  const opts = requestableOn(s, me, dayIdx, state.rules);
  const opt = opts.find(o => o.code === code);
  const holder = opt ? opt.holder : null;
  const plans = makeWholePlans(s, me, dayIdx, code, holder, state.rules, state.posts, state.wantsOff);

  $('shead').innerHTML = `<h2>${DOWFULL[d.dow] || d.dow}, ${MONTH[d.m]} ${d.d}</h2>
    <p><span class="mono">${esc(code)}${pos ? ' \u00b7 ' + esc(pos.time) : ''}</span> &mdash;
    ${holder ? 'currently ' + esc(holder.name) : 'unfilled'}</p>`;

  let h = '';
  if (holder) {
    const lost = s.hoursOf(code);
    h += `<div class="card"><div class="safe-in">
      <div class="lbl">${esc(holder.name)} would lose ${lost} hrs</div>
      <div class="hint">They hold a benefited line, so those hours are income they were counting on.
        Pick the option that suits them, not the one that suits you &mdash; and let them choose.</div>
    </div></div>
    <div class="eyebrow"><span>How they come out whole</span></div>`;

    const key = `${dayIdx}:${code}`;
    const chosenKey = state.chosen.get(key);
    plans.slice(0, 8).forEach((p, n) => {
      const bad = p.flags.some(f => f.severity === 'hard');
      const pk = planKey(p);
      const isChosen = chosenKey ? chosenKey === pk : n === 0;
      h += `<div class="card planpick${isChosen ? ' chosen' : ''}${bad ? ' urg' : ''}"
              data-plan="${key}##${esc(pk)}"><div class="plan">
        <div class="planhead">
          <span class="rank ${isChosen ? 'top' : bad ? 'warn' : ''}">${isChosen ? '\u2713' : n + 1}</span>
          <div><div class="cname">${esc(p.title)}</div>
            <div class="planmeta mono">${
              p.kind === 'pto' ? `\u2212${p.ptoHours} hrs PTO balance`
              : p.ownerHours === 0 ? 'hours unchanged'
              : `${p.ownerHours > 0 ? '+' : ''}${p.ownerHours} hrs`
            }${p.coverageDelta > 0 ? ' \u00b7 fills an open shift'
              : p.kind === 'relay' ? ' \u00b7 3 people' : ' \u00b7 coverage held'}</div>
          </div></div>
        <div class="plandet">${esc(p.detail)}</div>
        ${p.flags.length ? `<div class="reasons">${p.flags.map(f =>
          `<div class="rsn ${f.severity === 'hard' ? 'bad' : f.severity === 'cost' ? 'cost' : 'warn'}">
            <i>${f.severity === 'cost' ? '$' : '!'}</i>${esc(f.text)}</div>`).join('')}</div>` : ''}
        ${p.kind === 'relay' ? `<button class="wantsoff${state.wantsOff.has(p.third) ? ' on' : ''}"
            data-wantsoff="${esc(p.third)}">${state.wantsOff.has(p.third)
              ? `\u2713 ${esc(p.third)} wants the time off`
              : `${esc(p.third)} actually wants time off?`}</button>` : ''}
      </div></div>`;
    });
  } else {
    h += `<div class="card ok-card"><div class="safe-in">
      <div class="lbl">&#10003; Nobody holds this shift</div>
      <div class="hint">It is an unfilled required position. No one loses hours and nothing needs
        trading &mdash; this only needs your manager to say yes.</div>
    </div></div>`;
  }

  h += `${holder ? `<button class="btn p" data-act="closesheet">Use this plan</button>` : ''}
    <button class="btn o" data-ask="${holder ? esc(holder.name) : 'your manager'}">
      ${holder ? 'Ask ' + esc(holder.name.split(' ')[0]) : 'Ask your manager'}</button>
    <div class="disc">Nothing is agreed until they say yes and your manager approves it.</div>`;
  $('sbody').innerHTML = h;
  openSheet();
}

function render() {
  const s = state.sched;
  $('range').textContent = `${s.dateLabel(0)} \u2013 ${s.dateLabel(s.n - 1)}`;
  const body =
    state.tab === 'board' ? viewBoard() :
    state.tab === 'post'  ? viewPost()  :
    state.tab === 'mine'  ? viewMine()  :
    state.tab === 'want'  ? viewWant()  :
    state.tab === 'gaps'  ? viewGaps()  : viewSetup();
  $('main').innerHTML = (state.tab === 'setup' ? '' : demoBanner()) + body;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === state.tab));
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === state.tab));
  if (state.tab === 'setup') wireDrop();
}

/* ---------- coverage sheet ---------- */
function openCoverage(dayIdx, code, ownerName, postId) {
  const s = state.sched;
  const d = s.dates[dayIdx];
  const pos = s.position(code);
  const post = postId ? state.posts.find(p => p.id === postId) : null;

  $('shead').innerHTML = `<h2>${DOWFULL[d.dow] || d.dow}, ${MONTH[d.m]} ${d.d}</h2>
    <p><span class="mono">${esc(code)}${pos ? ' \u00b7 ' + esc(pos.time) : ''}</span>${
      ownerName ? ' &mdash; posted by ' + esc(ownerName) : ' &mdash; unfilled'}${
      post && post.kind === 'sick' ? ' <b style="color:var(--red)">(sick call)</b>' : ''}</p>`;

  if (post && post.takenBy) {
    $('sbody').innerHTML = `<div class="empty"><div class="big">${esc(post.takenBy)} picked this up</div>
      Still needs manager approval before it&rsquo;s final.</div>
      <button class="btn o" data-undo="${post.id}">Put it back on the board</button>`;
  } else {
    const all = findCoverage(s, dayIdx, code, ownerName, state.rules);
    const list = all.slice(0, 10);
    let h = `<div class="eyebrow"><span>Who can cover it</span>
             <span class="mono">${all.length} available</span></div><div class="card">`;
    list.forEach((c, n) => {
      const rankCls = c.unsafe ? 'warn' : n === 0 ? 'top' : '';
      h += `<div class="cand">
        <div class="rank ${rankCls}">${n + 1}</div>
        <div style="flex:1;min-width:0">
          <div class="cname">${esc(c.name)}<span class="hrs">${c.weeklyHours} hrs that week</span></div>
          <div class="reasons">${c.notes.map(x => `<div class="rsn ${x.kind}"><i>${
            x.kind === 'ok' ? '\u2713' : x.kind === 'trade' ? '\u21C4' :
            x.kind === 'cost' ? '$' : '!'}</i>${esc(x.text)}</div>`).join('')}</div>
          ${runBar(c.person, dayIdx, true)}
          <div style="margin-top:9px">${
            c.name === state.me && post
              ? `<button class="btn p sm" data-take="${post.id}">I&rsquo;ll take it</button>`
              : `<button class="btn o sm" data-ask="${esc(c.name)}">Ask ${esc(c.name.split(' ')[0])}</button>`
          }</div>
        </div></div>`;
    });
    h += '</div>';
    if (!all.length) h = `<div class="empty"><div class="big">Everyone is committed that day</div>
      No one on the schedule is free or marked off. This one goes to the manager.</div>`;
    h += `<div class="disc">Ranked by rest between shifts, consecutive days, how full their week already is,
          familiarity with the position, and whether a trade back is possible. Overtime is marked, never
          disqualifying &mdash; a short-staffed shift is the worse outcome.</div>`;
    $('sbody').innerHTML = h;
  }
  openSheet();
}

function openPostForm(idx) {
  const s = state.sched, p = s.person(state.me);
  const code = s.cell(p, idx), pos = s.position(code), d = s.dates[idx];
  state.pending = { idx, code, kind: 'giveaway' };
  $('shead').innerHTML = `<h2>Give up ${MONTH[d.m]} ${d.d}</h2>
    <p class="mono">${esc(code)}${pos ? ' \u00b7 ' + esc(pos.time) : ''}</p>`;
  $('sbody').innerHTML = `
    <div class="field"><label>What are you asking for</label>
      <div class="seg" id="kindseg">
        <button data-kind="giveaway" aria-pressed="true">Give it away</button>
        <button data-kind="swap" aria-pressed="false">Trade for another day</button>
        <button data-kind="sick" class="danger" aria-pressed="false">Sick call</button>
      </div></div>
    <div class="field"><label>Anything they should know</label>
      <textarea id="pnote" placeholder="Optional &mdash; e.g. happy to trade for anything later that month"></textarea></div>
    <button class="btn p" id="submitPost">Put it on the board</button>`;
  openSheet();
}

function openSheet() { $('scrim').classList.add('open'); $('sheet').classList.add('open'); }
function closeSheet() { state.openWantArgs = null; $('scrim').classList.remove('open'); $('sheet').classList.remove('open'); state.pending = null; }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
}

/* ---------- file loading ---------- */
function wireDrop() {
  const drop = $('drop'), file = $('file');
  if (!drop) return;
  ['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => {
    ev.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => {
    ev.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', ev => { if (ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]); });
  file.addEventListener('change', () => { if (file.files[0]) handleFile(file.files[0]); });
}

// If the sheet records availability by cell colour, start from it rather than
// making the person re-enter what their manager already wrote down.
function declaredAvailForPrefill(sched, person) {
  const declared = person && sched.declaredAvailable(person);
  if (!declared) return null;
  return new Set(declared.filter(i => {
    const v = sched.cell(person, i);
    return !v || v === 'x';
  }));
}

async function handleFile(f) {
  $('parseErr').innerHTML = '';
  try {
    const model = await readFile(f, { startMonth: new Date().getMonth() + 1 });
    if (!model.positions.length) {
      throw new Error('No shift times found. The sheet needs a legend somewhere pairing each code with its hours, e.g. "ED  1430-0100".');
    }
    invalidatePlans();
    state.sched = new Schedule(model);
    state.sched.raw = model;
    state.posts = [];
    state.picks = new Set();
    const meRow = model.staff.find(p => p.name === state.me) || model.staff[0];
    const prefill = declaredAvailForPrefill(state.sched, meRow);
    if (prefill) { state.avail = prefill; saveAvailability(state.avail); }
    state.me = state.sched.staff[0].name;
    fillPicker();
    await save();
    state.tab = 'board';
    render();
    toast(`Loaded ${model.staff.length} people \u2014 pick your name up top`);
  } catch (err) {
    $('parseErr').innerHTML = `<div class="err"><b>Couldn\u2019t read that file.</b><br>${esc(err.message)}
      <br><br>Check the layout against the example below. If it still won\u2019t load, the sheet is probably
      arranged differently from what the parser expects \u2014 that\u2019s a bug worth reporting, not your mistake.</div>`;
  }
}

function fillPicker() {
  const sel = $('me');
  sel.innerHTML = '';
  state.sched.staff
    .filter(p => state.sched.totalShifts(p) > 0)
    .map(p => p.name).sort()
    .forEach(n => {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
  if (!state.sched.person(state.me)) state.me = sel.options[0]?.value ?? null;
  sel.value = state.me;
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-open],[data-post],[data-take],[data-ask],[data-undo],[data-kind],[data-tab],[data-gap],[data-rule],[data-act],[data-avail],[data-want],[data-pick],[data-step],[data-week],[data-plan],[data-wantsoff],#submitPost');
  if (!t) return;

  if (t.dataset.avail !== undefined && t.hasAttribute('data-avail')) {
    const i = +t.dataset.avail;
    if (state.avail.has(i)) state.avail.delete(i); else state.avail.add(i);
    saveAvailability(state.avail); invalidatePlans(); render(); return;
  }
  if (t.dataset.want) {
    const [d, c] = t.dataset.want.split(':');
    openWant(+d, c); return;
  }
  if (t.dataset.wantsoff) {
    const who = t.dataset.wantsoff;
    if (state.wantsOff.has(who)) state.wantsOff.delete(who); else state.wantsOff.add(who);
    try { localStorage.setItem('shiftboard.wantsoff', JSON.stringify([...state.wantsOff])); } catch {}
    invalidatePlans();
    if (state.openWantArgs) openWant(...state.openWantArgs);
    render(); return;
  }
  if (t.dataset.plan) {
    const [key, pk] = t.dataset.plan.split('##');
    if (state.chosen.get(key) === pk) state.chosen.delete(key);
    else state.chosen.set(key, pk);
    state.picks.add(key);
    if (state.openWantArgs) openWant(...state.openWantArgs);
    render(); return;
  }
  if (t.dataset.pick) {
    if (state.picks.has(t.dataset.pick)) state.picks.delete(t.dataset.pick);
    else state.picks.add(t.dataset.pick);
    render(); return;
  }
  if (t.dataset.step) { state.wantMode = t.dataset.step; state.tab = 'want'; render(); return; }
  if (t.dataset.week !== undefined && t.hasAttribute('data-week')) {
    const me2 = state.sched.person(state.me);
    const w = +t.dataset.week;
    for (let i = w; i < Math.min(w + 7, state.sched.n); i++) {
      const v = state.sched.cell(me2, i);
      if (!v || v === 'x') state.avail.add(i);
    }
    saveAvailability(state.avail); invalidatePlans(); render(); return;
  }
  if (t.dataset.act === 'allfree') {
    freeDays(state.sched, state.sched.person(state.me)).forEach(i => state.avail.add(i));
    saveAvailability(state.avail); invalidatePlans(); render(); return;
  }
  if (t.dataset.act === 'weekends') {
    const me2 = state.sched.person(state.me);
    freeDays(state.sched, me2).forEach(i => {
      const d = state.sched.dates[i].dow;
      if (d === 'Sa' || d === 'Su') state.avail.add(i);
    });
    saveAvailability(state.avail); invalidatePlans(); render(); return;
  }
  if (t.dataset.act === 'clearavail') {
    state.avail.clear(); state.picks.clear();
    saveAvailability(state.avail); invalidatePlans(); render(); return;
  }
  if (t.dataset.act === 'copygroup' || t.dataset.act === 'copyplan') {
    const txt = planText(t.dataset.act === 'copygroup' ? 'group' : 'summary');
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(
      () => toast('Copied \u2014 paste it into your messages'),
      () => toast('Couldn\u2019t copy on this browser'));
    else toast('Copying isn\u2019t supported on this browser');
    return;
  }

  if (t.dataset.tab)  { state.tab = t.dataset.tab; closeSheet(); render(); return; }
  if (t.dataset.open) {
    const p = state.posts.find(x => x.id === t.dataset.open);
    if (p) openCoverage(p.idx, p.code, p.by, p.id);
    return;
  }
  if (t.hasAttribute('data-post')) { openPostForm(+t.dataset.post); return; }
  if (t.dataset.gap) {
    const [day, code] = t.dataset.gap.split(':');
    openCoverage(+day, code, null, null);
    return;
  }
  if (t.dataset.act === 'closesheet') { closeSheet(); render(); return; }
  if (t.dataset.act === 'pick') { $('file').click(); return; }
  if (t.dataset.act === 'reset') {
    forget();
    invalidatePlans();
    state.sched = new Schedule(DEMO); state.sched.raw = null;
    state.posts = seedPosts(state.sched);
    state.me = state.sched.staff[0].name;
    fillPicker(); await save(); render(); toast('Cleared — back to demo data');
    return;
  }
  if (t.dataset.rule) {
    const k = t.dataset.rule;
    state.rules[k] = !state.rules[k]; invalidatePlans();
    await save(); render(); return;
  }
  if (t.dataset.kind) {
    state.pending.kind = t.dataset.kind;
    document.querySelectorAll('#kindseg button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.kind === t.dataset.kind));
    return;
  }
  if (t.id === 'submitPost') {
    state.posts.push({
      id: 'p' + Date.now(), by: state.me, idx: state.pending.idx, code: state.pending.code,
      kind: state.pending.kind, note: $('pnote').value.trim(), takenBy: null
    });
    invalidatePlans(); await save(); closeSheet(); state.tab = 'board'; render();
    toast('Posted \u2014 the board will rank who can cover it');
    return;
  }
  if (t.dataset.take) {
    const p = state.posts.find(x => x.id === t.dataset.take);
    p.takenBy = state.me; invalidatePlans(); await save(); closeSheet(); render();
    toast('You\u2019ve got it. Manager still has to approve.');
    return;
  }
  if (t.dataset.undo) {
    const p = state.posts.find(x => x.id === t.dataset.undo);
    p.takenBy = null; invalidatePlans(); await save(); closeSheet(); render();
    toast('Back on the board');
    return;
  }
  if (t.dataset.ask) { toast(`In a deployed version this notifies ${t.dataset.ask}.`); return; }
});

document.addEventListener('change', async e => {
  if (e.target.dataset?.num) {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { state.rules[e.target.dataset.num] = v; invalidatePlans(); await save(); }
  }
});

$('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
$('me').addEventListener('change', e => {
  state.me = e.target.value;
  invalidatePlans();
  state.picks = new Set();
  const person = state.sched.person(state.me);
  const prefill = declaredAvailForPrefill(state.sched, person);
  state.avail = prefill || new Set();
  saveAvailability(state.avail);
  state.wantMode = 'days';
  closeSheet(); render();
});

/* ---------- boot ---------- */
function seedPosts(s) {
  const out = [];
  const pick = (name, code) => {
    const p = s.person(name);
    if (!p) return null;
    for (let i = 6; i < s.n; i++) if (s.cell(p, i) === code) return i;
    return null;
  };
  const a = s.staff[3], b = s.staff[7];
  const ai = a && Object.entries(a.shifts).find(([k, v]) => s.isWork(v) && +k > 8);
  const bi = b && Object.entries(b.shifts).find(([k, v]) => s.isWork(v) && +k > 14);
  if (ai) out.push({ id:'d1', by:a.name, idx:+ai[0], code:ai[1], kind:'giveaway',
                     note:'Family thing that weekend. Happy to trade.', takenBy:null });
  if (bi) out.push({ id:'d2', by:b.name, idx:+bi[0], code:bi[1], kind:'sick',
                     note:'Called out this morning.', takenBy:null });
  return out;
}

(async function boot() {
  await load();
  state.avail = loadAvailability();
  try {
    const w = localStorage.getItem('shiftboard.wantsoff');
    if (w) state.wantsOff = new Set(JSON.parse(w));
  } catch {}
  if (state.savedModel) {
    try {
      state.sched = new Schedule(state.savedModel);
      state.sched.raw = state.savedModel;
    } catch { state.savedModel = null; }
  }
  if (!state.sched) {
    state.sched = new Schedule(DEMO);
    state.sched.raw = null;
    if (!state.posts.length) state.posts = seedPosts(state.sched);
  }
  if (!state.sched.person(state.me)) state.me = state.sched.staff[0].name;
  fillPicker();
  render();
})();
