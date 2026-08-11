import { DEMO } from './demo-data.js';
import { Schedule, findCoverage, DEFAULT_RULES, LEAVE_CODES } from './engine.js';
import { readFile } from './parser.js';

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
  pending: null
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

function render() {
  const s = state.sched;
  $('range').textContent = `${s.dateLabel(0)} \u2013 ${s.dateLabel(s.n - 1)}`;
  const body =
    state.tab === 'board' ? viewBoard() :
    state.tab === 'post'  ? viewPost()  :
    state.tab === 'mine'  ? viewMine()  :
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
function closeSheet() { $('scrim').classList.remove('open'); $('sheet').classList.remove('open'); state.pending = null; }
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

async function handleFile(f) {
  $('parseErr').innerHTML = '';
  try {
    const model = await readFile(f, { startMonth: new Date().getMonth() + 1 });
    if (!model.positions.length) {
      throw new Error('No shift times found. The sheet needs a legend somewhere pairing each code with its hours, e.g. "ED  1430-0100".');
    }
    state.sched = new Schedule(model);
    state.sched.raw = model;
    state.posts = [];
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
  const t = e.target.closest('[data-open],[data-post],[data-take],[data-ask],[data-undo],[data-kind],[data-tab],[data-gap],[data-rule],[data-act],#submitPost');
  if (!t) return;

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
  if (t.dataset.act === 'pick') { $('file').click(); return; }
  if (t.dataset.act === 'reset') {
    forget();
    state.sched = new Schedule(DEMO); state.sched.raw = null;
    state.posts = seedPosts(state.sched);
    state.me = state.sched.staff[0].name;
    fillPicker(); await save(); render(); toast('Cleared — back to demo data');
    return;
  }
  if (t.dataset.rule) {
    const k = t.dataset.rule;
    state.rules[k] = !state.rules[k];
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
    await save(); closeSheet(); state.tab = 'board'; render();
    toast('Posted \u2014 the board will rank who can cover it');
    return;
  }
  if (t.dataset.take) {
    const p = state.posts.find(x => x.id === t.dataset.take);
    p.takenBy = state.me; await save(); closeSheet(); render();
    toast('You\u2019ve got it. Manager still has to approve.');
    return;
  }
  if (t.dataset.undo) {
    const p = state.posts.find(x => x.id === t.dataset.undo);
    p.takenBy = null; await save(); closeSheet(); render();
    toast('Back on the board');
    return;
  }
  if (t.dataset.ask) { toast(`In a deployed version this notifies ${t.dataset.ask}.`); return; }
});

document.addEventListener('change', async e => {
  if (e.target.dataset?.num) {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { state.rules[e.target.dataset.num] = v; await save(); }
  }
});

$('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
$('me').addEventListener('change', e => { state.me = e.target.value; closeSheet(); render(); });

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
