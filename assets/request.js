/*
 * request.js — "I want this shift" planning
 *
 * The board's original flow starts with someone giving a shift away. This is
 * the inverse: a per diem pharmacist names a shift they want, and the tool
 * works out how the person currently holding it comes out whole.
 *
 * Two rules shape everything below:
 *
 * 1. COVERAGE IS NEVER TRADED AWAY. Every plan is checked so that no required
 *    position ends the day with nobody on it. A plan that fills your shift by
 *    emptying another one is not a plan.
 *
 * 2. THE FTE HOLDER DECIDES WHAT "WHOLE" MEANS. Losing a shift costs a
 *    benefited employee real hours. PTO, a shift back, or another open shift
 *    are all valid answers, and which one is right depends on whether they
 *    want the time or the money. The tool ranks them; it does not choose.
 */

import { flagsFor, DEFAULT_RULES } from './engine.js';

/* ---------- availability ----------
 * A blank cell in a schedule means "not scheduled", never "available". Per
 * diem staff have real constraints the grid cannot see. So availability is
 * declared, not inferred.
 */
/**
 * Days the requester is not already committed. This is a *starting point* for
 * the availability picker, never an answer: not being scheduled says nothing
 * about whether someone can actually work. The user confirms or removes days.
 */
export function freeDays(sched, me) {
  const declared = sched.declaredAvailable(me);
  const out = [];
  for (let i = 0; i < sched.n; i++) {
    if (declared && !declared.includes(i)) continue;   // sheet says not available
    const v = sched.cell(me, i);
    if (v && sched.isWork(v)) continue;                // already working
    if (v && !sched.isWork(v) && v !== 'x') continue;  // approved leave
    out.push(i);
  }
  return out;
}

/**
 * Totals for an assembled set of requests, so the requester can see what the
 * whole package amounts to before asking anyone for anything.
 */
export function summarise(sched, requests, rules) {
  let gained = 0, givenBack = 0, ptoSpent = 0;
  const people = new Map();
  let openFilled = 0;

  for (const r of requests) {
    const p = r.best;
    if (!p) continue;
    gained += sched.paidHoursOf(r.code, rules);
    if (p.kind === 'open') { openFilled++; continue; }
    if (!r.holder) continue;

    const e = people.get(r.holder.name) || { name: r.holder.name, takes: [], gives: [], pto: 0, wantsIt: false };
    e.gives.push({ day: r.day, code: r.code });
    if (p.kind === 'swap') {
      e.takes.push({ day: p.giveBack.day, code: p.giveBack.code, from: 'you' });
      givenBack += sched.paidHoursOf(p.giveBack.code, rules);
    } else if (p.kind === 'pickup') {
      e.takes.push({ day: p.alt.day, code: p.alt.code, from: 'open' });
      openFilled++;
    } else if (p.kind === 'relay') {
      e.takes.push({ day: p.via.day, code: p.via.code, from: p.via.person });
      const t = people.get(p.via.person) || { name: p.via.person, takes: [], gives: [], pto: 0, wantsIt: false };
      t.gives.push({ day: p.via.day, code: p.via.code, to: r.holder.name });
      /* Marked as wanting the time off, so the day they hand over is a PTO day
       * they asked for. Without this the relay reads as bare hours taken off
       * them everywhere outside the plan card — including in the message you
       * actually send, which is the one place it matters most. Paid hours,
       * because a PTO day pays the shift's paid hours, not its clock hours. */
      if (p.thirdTakesPto) {
        const h = sched.paidHoursOf(p.via.code, rules);
        t.pto += h;
        t.wantsIt = true;
        ptoSpent += h;
      }
      people.set(p.via.person, t);
    } else if (p.kind === 'pto') {
      e.pto += p.ptoHours;
      ptoSpent += p.ptoHours;
    }
    people.set(r.holder.name, e);
  }

  return {
    netHours: Math.round((gained - givenBack) * 10) / 10,
    gained: Math.round(gained * 10) / 10,
    givenBack: Math.round(givenBack * 10) / 10,
    ptoSpent: Math.round(ptoSpent * 10) / 10,
    openFilled,
    people: [...people.values()]
  };
}

export function loadAvailability() {
  try {
    const raw = localStorage.getItem('shiftboard.avail');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
export function saveAvailability(set) {
  try { localStorage.setItem('shiftboard.avail', JSON.stringify([...set])); } catch {}
}

/* ---------- coverage accounting ---------- */

/** Who holds `code` on day `i`, if anyone. */
function holderOf(sched, i, code) {
  return sched.staff.find(p => sched.cell(p, i) === code) || null;
}

/**
 * Is this position required on this day?
 *
 * A schedule that ships a coverage sheet is authoritative: a position absent
 * from it is not required, full stop. Assuming otherwise invents gaps for
 * legend-only codes (a clinic that doesn't run this period, say) and then
 * offers those phantom gaps as real shifts to pick up.
 *
 * With no coverage sheet at all, fall back to observed staffing: a position
 * consistently filled is treated as required on the days it is normally
 * filled, and never on days it isn't.
 */
function isRequired(sched, i, code) {
  const req = sched.required[code];
  if (req) return req[i] !== false;

  // No explicit map for this code. If the schedule has one for other codes,
  // this code was deliberately left out — treat it as not required.
  if (Object.keys(sched.required).length > 0) return false;

  // No coverage sheet anywhere: infer from how the position is actually run.
  const pat = inferredPattern(sched, code);
  return pat ? pat[i] : false;
}

/** Cheap pre-filter: does this person work at all in this period? */
const _spareCache = new WeakMap();
function thirdHasSpareShift(sched, person) {
  let m = _spareCache.get(sched);
  if (!m) { m = new Map(); _spareCache.set(sched, m); }
  if (m.has(person.name)) return m.get(person.name);
  const v = sched.totalShifts(person) > 0;
  m.set(person.name, v);
  return v;
}

const _patternCache = new Map();
function inferredPattern(sched, code) {
  if (_patternCache.has(code)) return _patternCache.get(code);
  const filled = [];
  let count = 0;
  for (let i = 0; i < sched.n; i++) {
    const on = sched.staff.some(p => sched.cell(p, i) === code);
    filled.push(on);
    if (on) count++;
  }
  // Never staffed, or staffed once or twice — not a standing position.
  const pat = count < 3 ? null : filled;
  _patternCache.set(code, pat);
  return pat;
}

/**
 * Does this set of moves leave a required position with nobody on it?
 *
 * The obvious version rescans the whole schedule, which is O(days x positions
 * x staff) and sits inside loops that run thousands of times per request. But
 * a move can only endanger the position it vacated, so only those cells need
 * checking. This is the difference between a request taking half a minute and
 * taking no time at all.
 */
export function createsGap(sched, moves = []) {
  const overlay = new Map();
  for (const m of moves) overlay.set(`${m.person.name}|${m.day}`, m.code);
  const cellOf = (p, i) => {
    const k = `${p.name}|${i}`;
    return overlay.has(k) ? overlay.get(k) : sched.cell(p, i);
  };
  for (const m of moves) {
    const vacated = sched.cell(m.person, m.day);
    if (!vacated || vacated === m.code) continue;
    if (!sched.isWork(vacated)) continue;
    if (!isRequired(sched, m.day, vacated)) continue;
    if (!sched.staff.some(p => cellOf(p, m.day) === vacated)) return true;
  }
  return false;
}

/**
 * Required positions with nobody on them, after applying a set of moves.
 * A move is { person, day, code } where code === null means "now off".
 */
export function gapsAfter(sched, moves = []) {
  const overlay = new Map();
  for (const m of moves) overlay.set(`${m.person.name}|${m.day}`, m.code);

  const cellOf = (p, i) => {
    const k = `${p.name}|${i}`;
    return overlay.has(k) ? overlay.get(k) : sched.cell(p, i);
  };

  const out = [];
  for (let i = 0; i < sched.n; i++) {
    for (const pos of sched.positions) {
      if (!isRequired(sched, i, pos.code)) continue;
      const filled = sched.staff.some(p => cellOf(p, i) === pos.code);
      if (!filled) out.push({ day: i, code: pos.code });
    }
  }
  return out;
}

/** Required positions nobody is assigned to right now. */
const _openCache = new WeakMap();
export function openShifts(sched) {
  if (_openCache.has(sched)) return _openCache.get(sched);
  const v = gapsAfter(sched, []);
  _openCache.set(sched, v);
  return v;
}

/* ---------- what could I ask for? ---------- */

/**
 * Every shift the requester could plausibly take on a day they're available:
 * unfilled required positions first, then shifts currently held by someone else.
 */
export function requestableOn(sched, me, dayIdx, rules = DEFAULT_RULES) {
  const out = [];
  const mine = sched.cell(me, dayIdx);
  if (mine && sched.isWork(mine)) return out;      // already working that day

  for (const pos of sched.positions) {
    if (!isRequired(sched, dayIdx, pos.code)) continue;
    const holder = holderOf(sched, dayIdx, pos.code);

    // Would taking this break the requester's own rest or runs?
    const { flags } = flagsFor(sched, me, dayIdx, pos.code, rules);
    if (flags.some(f => f.severity === 'hard')) continue;   // can't safely work it

    out.push({
      code: pos.code,
      time: pos.time,
      holder,
      open: !holder,
      myFlags: flags
    });
  }

  // Unfilled first, then by how often the requester has worked that position.
  out.sort((a, b) =>
    (b.open - a.open) || (sched.timesWorked(me, b.code) - sched.timesWorked(me, a.code)));
  return out;
}

/* ---------- making the FTE holder whole ---------- */

/** Pay-side hours. PTO, hour deltas and weekly totals all use this. */
const HOURS = (sched, code, rules) => sched.paidHoursOf(code, rules);

/**
 * Can this person work that day at all? Not committed, and — where the sheet
 * records availability — actually marked available. Without that second test
 * the planner cheerfully proposes shifts to people who already said no.
 */
function canWork(sched, person, day) {
  const a = sched.availability(person, day);
  if (a !== 'free' && a !== 'off') return false;
  const declared = sched.declaredAvailable(person);
  if (declared && !declared.includes(day)) return false;
  return true;
}

/**
 * Flags dominate proximity. A plan that costs the department overtime or puts
 * someone on a ninth straight day should never outrank a clean one just
 * because it falls closer on the calendar.
 */
function flagCost(flags) {
  let c = 0;
  for (const f of flags) {
    if (f.severity === 'hard') c += 400;
    else if (f.severity === 'cost') c += 60;
    else c += 25;
  }
  return c;
}

/**
 * Ranked plans for taking `code` on `dayIdx` from `holder`.
 * Returns [] when the shift is unfilled — nothing to make whole.
 */
export function makeWholePlans(sched, me, dayIdx, code, holder, rules = DEFAULT_RULES, posts = [], wantsOff = new Set()) {
  if (!holder) {
    return [{
      kind: 'open',
      title: 'Nobody holds this shift',
      detail: 'It is an unfilled required position, so no one loses hours. This only needs manager approval.',
      ownerHours: 0,
      coverageDelta: +1,
      flags: [],
      clean: true,
      score: 1000
    }];
  }

  const lost = HOURS(sched, code, rules);
  const plans = [];

  // The requester taking the shift is common to every plan.
  const baseMoves = [
    { person: holder, day: dayIdx, code: null },
    { person: me,     day: dayIdx, code }
  ];

  /* --- Plan A: holder takes one of the requester's existing shifts --- */
  for (let j = 0; j < sched.n; j++) {
    if (j === dayIdx) continue;
    const mineCode = sched.cell(me, j);
    if (!sched.isWork(mineCode)) continue;

    if (!canWork(sched, holder, j)) continue;

    const { flags } = flagsFor(sched, holder, j, mineCode, rules);
    if (flags.some(f => f.severity === 'hard')) continue;

    const moves = [...baseMoves,
      { person: me,     day: j, code: null },
      { person: holder, day: j, code: mineCode }];
    if (createsGap(sched, moves)) continue;

    const delta = HOURS(sched, mineCode, rules) - lost;
    plans.push({
      kind: 'swap',
      title: `They take your ${sched.dateLabel(j)} ${mineCode}`,
      detail: delta === 0
        ? 'Straight trade. Their hours and yours both end up unchanged, and no shift goes uncovered.'
        : `They end the period ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} hrs on the trade.`,
      ownerHours: delta,
      coverageDelta: 0,
      giveBack: { day: j, code: mineCode },
      flags,
      clean: flags.length === 0 && delta === 0,
      score: 900 - Math.abs(delta) * 8 - flagCost(flags) - Math.abs(j - dayIdx) * 0.05
    });
  }

  /* --- Plan B: holder picks up an unfilled required shift instead --- */
  for (const gap of openShifts(sched)) {
    if (gap.day === dayIdx) continue;
    if (!canWork(sched, holder, gap.day)) continue;

    const { flags } = flagsFor(sched, holder, gap.day, gap.code, rules);
    if (flags.some(f => f.severity === 'hard')) continue;

    const delta = HOURS(sched, gap.code, rules) - lost;
    plans.push({
      kind: 'pickup',
      title: `They pick up the open ${sched.dateLabel(gap.day)} ${gap.code}`,
      detail: 'Fills a position that currently has nobody on it, so the department comes out ahead.',
      ownerHours: delta,
      coverageDelta: +1,
      alt: gap,
      flags,
      clean: flags.length === 0 && delta >= 0,
      score: 890 - Math.abs(delta) * 8 - flagCost(flags)
    });
  }

  /* --- Plan C: a third person hands the holder a shift ---
   *
   * The relay. You take the holder's shift, and the holder is made whole from
   * someone else's line rather than yours. This is the shape most real swaps
   * take, because the person with hours to spare is rarely the person asking.
   *
   * It only works when the third party actually wants to lose those hours, so
   * a shift already posted on the board is treated as the strong case and
   * everything else is flagged as needing their agreement first.
   */
  const posted = new Set(
    posts.filter(p => !p.takenBy).map(p => `${p.by}|${p.idx}`));

  /* Candidates are gathered before they're scored, so shifts already posted on
   * the board are always considered first. Capping by discovery order instead
   * would cut off the best answers purely because they sat lower in the sheet. */
  const relayCandidates = [];
  for (const third of sched.staff) {
    if (third.name === holder.name || third.name === me.name) continue;
    if (!thirdHasSpareShift(sched, third)) continue;
    for (let j = 0; j < sched.n; j++) {
      if (j === dayIdx) continue;
      const tCode = sched.cell(third, j);
      if (!sched.isWork(tCode)) continue;
      if (!canWork(sched, holder, j)) continue;
      relayCandidates.push({ third, j, tCode,
        wants: posted.has(`${third.name}|${j}`) || wantsOff.has(third.name) });
    }
  }
  /* Ordering has to reflect plan quality, because the cap below is a hard cut.
   * Sorting by calendar distance alone would let a nearer but worse candidate
   * push out a clean one purely because it sits closer on the sheet. So:
   * posted shifts first, then the smallest change to the holder's hours, and
   * only then distance as a readability tiebreak. */
  const lostHours = lost;
  relayCandidates.sort((a, b) =>
    (b.wants - a.wants) ||
    (Math.abs(HOURS(sched, a.tCode, rules) - lostHours) - Math.abs(HOURS(sched, b.tCode, rules) - lostHours)) ||
    (Math.abs(a.j - dayIdx) - Math.abs(b.j - dayIdx)));

  for (const { third, j, tCode, wants } of relayCandidates.slice(0, 30)) {
    const { flags } = flagsFor(sched, holder, j, tCode, rules);
    if (flags.some(f => f.severity === 'hard')) continue;

    const moves = [...baseMoves,
      { person: third,  day: j, code: null },
      { person: holder, day: j, code: tCode }];
    if (createsGap(sched, moves)) continue;

    const delta = HOURS(sched, tCode, rules) - lost;
    const askedFor = wantsOff.has(third.name);
    const relayFlags = wants ? flags : [...flags, {
      severity: 'note', key: 'third-party',
      text: `${third.name} would lose ${HOURS(sched, tCode, rules)} paid hrs \u2014 only works if they want the time off`
    }];

    plans.push({
      kind: 'relay',
      third: third.name,
      title: wants
        ? `${holder.name} covers ${third.name}\u2019s ${sched.dateLabel(j)} ${tCode}`
        : `${holder.name} takes ${third.name}\u2019s ${sched.dateLabel(j)} ${tCode}`,
      detail: askedFor
        ? `${third.name} wants time off, so they take PTO for that day and ${holder.name} covers it. Everyone gets what they were after.`
        : wants
        ? `${third.name} already put that shift on the board, so this settles two problems at once.`
        : `Makes ${holder.name} whole without touching your shifts \u2014 but it moves the lost hours onto ${third.name}, so they have to want it.`,
      thirdTakesPto: askedFor,
      ownerHours: delta,
      coverageDelta: 0,
      via: { day: j, code: tCode, person: third.name, posted: posted.has(`${third.name}|${j}`), takesPto: askedFor },
      flags: relayFlags,
      clean: wants && flags.length === 0 && delta >= 0,
      score: (wants ? 930 : 820) - Math.abs(delta) * 8 - flagCost(relayFlags)
    });
  }

  /* --- Plan D: holder takes PTO --- */
  {
    const coverageOk = !createsGap(sched, baseMoves);
    plans.push({
      kind: 'pto',
      title: 'They take PTO for the day',
      detail: coverageOk
        ? `Their shift stays covered because you are working it. They spend ${lost} hrs of accrued PTO \u2014 the paid hours of the shift, not the clock hours, since the meal period is unpaid.`
        : 'This would leave a required position uncovered.',
      ownerHours: 0,
      ptoHours: lost,
      coverageDelta: 0,
      flags: coverageOk ? [] : [{ severity: 'hard', key: 'coverage', text: 'Would leave a required position uncovered' }],
      clean: false,
      score: coverageOk ? 700 : -100
    });
  }

  plans.sort((a, b) => b.score - a.score);
  return plans;
}

/**
 * Everything the requester could ask for, across every day they marked available.
 */
export function planRequests(sched, me, availability, rules = DEFAULT_RULES, posts = [], wantsOff = new Set()) {
  const out = [];
  for (const i of [...availability].sort((a, b) => a - b)) {
    if (i < 0 || i >= sched.n) continue;
    for (const opt of requestableOn(sched, me, i, rules)) {
      const plans = makeWholePlans(sched, me, i, opt.code, opt.holder, rules, posts, wantsOff);
      out.push({ day: i, ...opt, plans, best: plans[0] || null });
    }
  }
  return out;
}

/**
 * Requesting several shifts at once is where plans quietly collide: the same
 * give-back shift can look like the answer to three different requests, and
 * you only have it once. Walks the chosen requests in order and drops any plan
 * whose give-back has already been spent.
 */
/**
 * Identify a plan stably across recomputes, so a choice survives a re-render.
 */
export function planKey(p) {
  if (!p) return null;
  if (p.kind === 'swap')   return `swap|${p.giveBack.day}|${p.giveBack.code}`;
  if (p.kind === 'relay')  return `relay|${p.via.person}|${p.via.day}|${p.via.code}`;
  if (p.kind === 'pickup') return `pickup|${p.alt.day}|${p.alt.code}`;
  return p.kind;
}

/**
 * @param chosen  Map of "day:code" -> planKey, for plans the user picked by
 *                hand. A deliberate choice always wins over the ranking; the
 *                ranking is a suggestion, not a decision.
 */
export function reconcile(requests, chosen = new Map()) {
  const spent = new Set();      // give-back shifts already promised
  const dayTaken = new Set();   // days the requester is now working
  const out = requests.map(r => ({ ...r }));

  /* Requests you chose a plan for are settled before the rest, so a deliberate
   * choice reserves its give-back ahead of any plan the tool merely ranked
   * first. Walking in list order instead would let an earlier request's top
   * pick spend the very shift a later request was explicitly chosen for, and
   * report the choice as `chosenMissing` — the ranking beating the decision,
   * which is the thing this is meant to prevent. Sorting is stable, so within
   * each group the caller's order still decides a genuine collision. */
  const order = [...requests.keys()].sort((a, b) =>
    (chosen.has(`${requests[b].day}:${requests[b].code}`) ? 1 : 0) -
    (chosen.has(`${requests[a].day}:${requests[a].code}`) ? 1 : 0));

  const settle = r => {
    // You can only be in one place at a time. If an earlier request already
    // claimed this day, everything after it on the same day is unworkable.
    if (dayTaken.has(r.day)) {
      return { plans: [], best: null, chosenByUser: false, chosenMissing: false, conflicted: true,
               conflictReason: 'You already picked up a different shift that day.' };
    }

    const viable = r.plans.filter(p => {
      if (p.kind === 'swap') {
        // Can't give back a shift you've already promised, or the one you're
        // standing in on the day you just picked up.
        if (spent.has(p.giveBack.day)) return false;
        if (p.giveBack.day === r.day) return false;
        return true;
      }
      if (p.kind === 'relay') {
        // The same third-party shift can only be handed over once.
        return !spent.has(`${p.via.person}|${p.via.day}`);
      }
      return true;
    });

    const want = chosen.get(`${r.day}:${r.code}`);
    const picked = want ? viable.find(p => planKey(p) === want) : null;
    const best = picked || viable[0] || null;
    if (best) {
      dayTaken.add(r.day);
      if (best.kind === 'swap')  spent.add(best.giveBack.day);
      if (best.kind === 'relay') spent.add(`${best.via.person}|${best.via.day}`);
    }
    return { plans: viable, best,
             chosenByUser: !!picked,
             chosenMissing: !!want && !picked,
             conflicted: viable.length < r.plans.length,
             conflictReason: viable.length ? null
               : 'The give-back that would have worked is already committed elsewhere.' };
  };

  for (const ix of order) Object.assign(out[ix], settle(requests[ix]));
  return out;
}

/* ============================================================
   Sick calls
   ============================================================

   A different problem from a planned swap, and it needs different rules.

   Planned swaps can afford to only consider people who marked themselves
   available. A sick call cannot: the shift starts in a few hours and someone
   has to be on it. So this shows everyone who isn't already committed, sorted
   into who is likely to say yes rather than filtered down to them.

   The one thing it will not do is bury a rest problem. Someone finishing at
   0100 should not be first pick for an 0630, however desperate the phone call
   is, so those land in their own tier with the reason attached.
*/

export const SICK_TIERS = [
  { key: 'ready', label: 'Said they\u2019re available',
    hint: 'Marked available on the schedule and not working. Start here.' },
  { key: 'free', label: 'Not working, didn\u2019t mark availability',
    hint: 'No commitment that day. Worth a call \u2014 they just never said either way.' },
  { key: 'tight', label: 'Free, but the timing is rough',
    hint: 'Could physically do it, but it cuts into rest or makes a long run.' },
  { key: 'leave', label: 'On approved leave',
    hint: 'Booked time off. Only if you have exhausted everything else.' }
];

/**
 * Who could cover `code` on `dayIdx`, sorted into tiers.
 * Nobody is hidden except people already working that day, who genuinely can't.
 */
export function sickCallCandidates(sched, dayIdx, code, rules = DEFAULT_RULES) {
  const out = { ready: [], free: [], tight: [], leave: [], working: [] };
  const anyDeclared = sched.staff.some(p => sched.declaredAvailable(p));

  for (const p of sched.staff) {
    if (sched.totalShifts(p) === 0) continue;          // not on this schedule at all
    const state = sched.availability(p, dayIdx);
    const already = sched.cell(p, dayIdx);

    if (state === 'working') {
      out.working.push({ person: p, name: p.name, code: already });
      continue;
    }

    const { flags, weeklyHours, run, turnaround } = flagsFor(sched, p, dayIdx, code, rules);
    const hard = flags.filter(f => f.severity === 'hard');
    const declared = sched.declaredAvailable(p);
    const marked = declared ? declared.includes(dayIdx) : null;
    const familiar = sched.timesWorked(p, code);

    // Two different numbers, and conflating them makes the tool look broken to
    // anyone who knows the schedule: what they already work this week, and what
    // they'd work if they took this shift. Show both, labelled.
    const currentHours = sched.weeklyHours(p, dayIdx, null, null, rules);
    const shiftsThisWeek = sched.weekOf(dayIdx).filter(i => sched.worksOn(p, i)).length;

    const entry = {
      person: p, name: p.name, flags, weeklyHours, run, turnaround, familiar,
      currentHours, shiftsThisWeek,
      marked, load: sched.totalShifts(p),
      costly: flags.some(f => f.severity === 'cost')
    };

    let tier;
    if (state === 'leave')           tier = 'leave';
    else if (hard.length)            tier = 'tight';
    else if (run.length >= rules.longRunDays) tier = 'tight';
    else if (marked === true)        tier = 'ready';
    else if (marked === false)       tier = 'free';   // sheet says no, but ask anyway
    else                             tier = anyDeclared ? 'free' : 'ready';

    // Someone the sheet marks unavailable belongs below those who said nothing.
    entry.declinedOnSheet = marked === false;
    out[tier].push(entry);
  }

  const rank = (a, b) =>
    (a.declinedOnSheet - b.declinedOnSheet) ||
    (a.costly - b.costly) ||
    (b.familiar - a.familiar) ||
    (a.run.length - b.run.length) ||
    (a.load - b.load);

  for (const k of ['ready', 'free', 'tight', 'leave']) out[k].sort(rank);
  return out;
}
