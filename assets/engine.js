/*
 * engine.js — coverage matching and labor flags
 *
 * Design notes worth keeping in mind if you extend this:
 *
 * 1. A blank cell means "not scheduled". It does NOT mean "available".
 *    Nothing in a schedule grid tells you who WANTS to work. Availability
 *    is something people declare; this engine only narrows the field to
 *    who is not already committed.
 *
 * 2. Familiarity with a position is a soft signal, never a filter. In a
 *    cross-trained department, "has not been assigned ED lately" says
 *    something about the scheduler's habits, not about competence.
 *
 * 3. Overtime is a flag, never a veto. A short-staffed shift is worse
 *    than an expensive one. Flags exist so the manager sees the cost
 *    before approving, not so the tool refuses to suggest someone.
 *
 * NOT MODELLED, and you should not assume otherwise:
 *   - Collective bargaining terms. Some contracts require open shifts be
 *     offered by seniority, or posted for a set window before assignment.
 *     This ranks by fit and cost, which can contradict a contractual order.
 *   - Meal and rest break premiums.
 *   - Per diem commitment minimums, float differentials, shift differentials.
 *   - Competency sign-off. "Has worked this position" is not credentialling.
 *   - Whether anyone actually wants the shift.
 *
 * Treat every flag as a prompt to check the real policy, never as the answer.
 */

export const LEAVE_CODES = new Set(['PTO','pto','HOL','hol','LOA','S','SICK','VAC','Vac','CE','NEO']);
export const NEUTRAL_CODES = new Set(['x','X','off','OFF','-']);

/* ---------- time helpers ---------- */

export function parseSpan(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).match(/(\d{1,2}):?(\d{2})\s*[-–—]\s*(\d{1,2}):?(\d{2})/);
  if (!m) return null;
  let s = (+m[1]) * 60 + (+m[2]);
  let e = (+m[3]) * 60 + (+m[4]);
  if (e <= s) e += 1440;              // crosses midnight
  return { start: s, end: e, hours: (e - s) / 60 };
}

export class Schedule {
  constructor(model) {
    this.dates     = model.dates;
    this.positions = model.positions;
    this.required  = model.required || {};
    this.staff     = model.staff;
    this.meta      = model.meta || {};
    this.weekStart = this.meta.weekStart ?? 0;   // 0 = Sunday
    this.n         = model.dates.length;
    this._pos      = Object.fromEntries(model.positions.map(p => [p.code, p]));
    this._span     = Object.fromEntries(
      model.positions.map(p => [p.code, parseSpan(p.time)])
    );
    this._byName   = Object.fromEntries(model.staff.map(p => [p.name, p]));
  }

  person(name)       { return this._byName[name]; }
  position(code)     { return this._pos[code]; }
  span(code)         { return this._span[code] || null; }
  cell(person, i)    { return person.shifts[String(i)] ?? null; }

  isWork(code) {
    return !!code && !LEAVE_CODES.has(code) && !NEUTRAL_CODES.has(code) && !!this._pos[code];
  }
  worksOn(person, i) { return this.isWork(this.cell(person, i)); }

  /** Days this person marked available in the source sheet, if it encoded any. */
  declaredAvailable(person) {
    return Array.isArray(person.available) ? person.available : null;
  }

  /** free | off | leave | working */
  availability(person, i) {
    const v = this.cell(person, i);
    if (v == null) return 'free';
    if (NEUTRAL_CODES.has(v)) return 'off';
    if (LEAVE_CODES.has(v)) return 'leave';
    return 'working';
  }

  dateLabel(i) {
    const d = this.dates[i];
    const MONTH = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${MONTH[d.m]} ${d.d}`;
  }

  hoursOf(code) {
    const s = this.span(code);
    return s ? s.hours : 0;
  }

  /** Indices of the pay week containing day i. */
  weekOf(i) {
    const DOW = ['Su','M','T','W','Th','F','Sa'];
    const idx = DOW.indexOf(this.dates[i].dow === 'Fr' ? 'F' : this.dates[i].dow);
    const offset = (idx - this.weekStart + 7) % 7;
    const start = i - offset;
    const out = [];
    for (let k = start; k < start + 7; k++) if (k >= 0 && k < this.n) out.push(k);
    return out;
  }

  weeklyHours(person, i, extraCode = null, extraIdx = null) {
    let total = 0;
    for (const k of this.weekOf(i)) {
      if (k === extraIdx && extraCode) { total += this.hoursOf(extraCode); continue; }
      const c = this.cell(person, k);
      if (this.isWork(c)) total += this.hoursOf(c);
    }
    return Math.round(total * 10) / 10;
  }

  /** Length of the consecutive worked-day run through i, treating i as worked. */
  runThrough(person, i) {
    let a = i, b = i;
    while (a - 1 >= 0 && this.worksOn(person, a - 1)) a--;
    while (b + 1 < this.n && this.worksOn(person, b + 1)) b++;
    return { start: a, end: b, length: b - a + 1 };
  }

  /** Hours off between the proposed shift and whatever sits either side. */
  turnaround(person, i, code) {
    const cur = this.span(code);
    if (!cur) return { hours: null };
    let worst = Infinity, against = null;

    const prev = this.cell(person, i - 1);
    if (this.isWork(prev)) {
      const p = this.span(prev);
      const gap = (1440 + cur.start - p.end) / 60;
      if (gap < worst) { worst = gap; against = `${prev} the day before`; }
    }
    const next = this.cell(person, i + 1);
    if (this.isWork(next)) {
      const nx = this.span(next);
      const gap = (1440 + nx.start - cur.end) / 60;
      if (gap < worst) { worst = gap; against = `${next} the next day`; }
    }
    if (worst === Infinity) return { hours: null };
    return { hours: Math.round(worst * 10) / 10, against };
  }

  totalShifts(person) {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.worksOn(person, i)) n++;
    return n;
  }

  timesWorked(person, code) {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.cell(person, i) === code) n++;
    return n;
  }

  /** Required positions with nobody assigned, by day. */
  gaps() {
    const out = [];
    for (let i = 0; i < this.n; i++) {
      for (const p of this.positions) {
        const req = this.required[p.code];
        if (req && req[i] === false) continue;
        if (!req) continue;
        const filled = this.staff.some(s => this.cell(s, i) === p.code);
        if (!filled) out.push({ day: i, code: p.code });
      }
    }
    return out;
  }
}

/* ---------- labor flags ---------- */

export const DEFAULT_RULES = {
  minTurnaroundHours: 8,        // below this, flag as a rest problem
  cautionTurnaround: 10,
  longRunDays: 6,               // consecutive days before a stretch reads as heavy
  weeklyOvertimeHours: 40,
  alternativeWorkweek: true,    // true = 10s/12s straight time up to the daily cap
  dailyStraightTimeCap: 12,     // hours in a day before double time
  seventhDayPremium: true,      // 7th consecutive day in a pay week
  seventhDayDoubleAfter: 8,     // on a 7th day, hours past this are double time
  noticeDays: 0                 // 0 = off. Set to your policy's minimum swap notice
};

/**
 * Flags are advisory. Nothing here removes a candidate.
 * severity: 'hard' (safety / rest), 'cost' (money), 'note' (worth knowing)
 */
export function flagsFor(sched, person, i, code, rules = DEFAULT_RULES) {
  const flags = [];
  const shiftHours = sched.hoursOf(code);

  const ta = sched.turnaround(person, i, code);
  if (ta.hours != null && ta.hours < rules.minTurnaroundHours) {
    flags.push({ severity:'hard', key:'rest',
      text:`Only ${ta.hours} hrs off before ${ta.against}` });
  } else if (ta.hours != null && ta.hours < rules.cautionTurnaround) {
    flags.push({ severity:'note', key:'rest-tight',
      text:`${ta.hours} hrs between this and ${ta.against}` });
  }

  const probe = { ...person, shifts: { ...person.shifts, [String(i)]: code } };
  const run = sched.runThrough(probe, i);
  if (run.length >= rules.longRunDays) {
    flags.push({ severity:'note', key:'run',
      text:`Would be ${run.length} days in a row` });
  }

  const week = sched.weekOf(i);
  let consecutiveInWeek = 0, isSeventh = false;
  for (const k of week) {
    const worked = k === i ? true : sched.worksOn(person, k);
    consecutiveInWeek = worked ? consecutiveInWeek + 1 : 0;
    if (k === i && consecutiveInWeek >= 7) isSeventh = true;
  }
  if (rules.seventhDayPremium && isSeventh) {
    const dt = shiftHours - rules.seventhDayDoubleAfter;
    flags.push({ severity:'cost', key:'seventh',
      text: dt > 0
        ? `7th consecutive day — premium, and ${Math.round(dt * 10) / 10} hrs at double time`
        : '7th consecutive day in the pay week — premium rate' });
  }

  const wk = sched.weeklyHours(person, i, code, i);
  if (wk > rules.weeklyOvertimeHours) {
    flags.push({ severity:'cost', key:'weekly-ot',
      text:`${wk} hrs that pay week — ${Math.round((wk - rules.weeklyOvertimeHours) * 10) / 10} over` });
  }

  if (!rules.alternativeWorkweek && shiftHours > 8) {
    flags.push({ severity:'cost', key:'daily-ot',
      text:`${shiftHours} hr shift — daily overtime past 8` });
  }
  if (shiftHours > rules.dailyStraightTimeCap) {
    flags.push({ severity:'cost', key:'double-time',
      text:`${shiftHours} hr shift — ${Math.round((shiftHours - rules.dailyStraightTimeCap) * 10) / 10} hrs at double time` });
  }

  if (rules.noticeDays > 0 && typeof rules.todayIndex === 'number') {
    const daysOut = i - rules.todayIndex;
    if (daysOut >= 0 && daysOut < rules.noticeDays) {
      flags.push({ severity:'note', key:'notice',
        text:`${daysOut} days notice — policy asks for ${rules.noticeDays}` });
    }
  }

  return { flags, weeklyHours: wk, run, turnaround: ta };
}

/* ---------- matching ---------- */

/**
 * Rank everyone who is not already committed on that day.
 * Returns candidates sorted best-first. Nobody is excluded for cost.
 */
export function findCoverage(sched, dayIdx, code, ownerName, rules = DEFAULT_RULES) {
  const owner = ownerName ? sched.person(ownerName) : null;
  const results = [];

  for (const p of sched.staff) {
    if (p.name === ownerName) continue;
    const av = sched.availability(p, dayIdx);
    if (av !== 'free' && av !== 'off') continue;
    const declared = sched.declaredAvailable(p);
    if (declared && !declared.includes(dayIdx)) continue;   // sheet says not available
    if (sched.totalShifts(p) === 0) continue;      // not working this period at all

    const { flags, weeklyHours, run, turnaround } = flagsFor(sched, p, dayIdx, code, rules);
    const load = sched.totalShifts(p);
    const familiar = sched.timesWorked(p, code);

    const notes = [];
    notes.push({ kind:'ok', text: av === 'free' ? 'Nothing scheduled that day' : 'Marked off that day' });
    if (familiar > 0) notes.push({ kind:'ok', text:`Has worked ${code} ${familiar}× this period` });
    if (load <= 8)    notes.push({ kind:'ok', text:`Light period — ${load} shifts scheduled` });

    // Reciprocal trade: a shift of theirs the owner could take back.
    let trade = null;
    if (owner) {
      let best = null;
      for (let j = 0; j < sched.n; j++) {
        const c = sched.cell(p, j);
        if (!sched.isWork(c)) continue;
        const oa = sched.availability(owner, j);
        if (oa !== 'free' && oa !== 'off') continue;
        const back = flagsFor(sched, owner, j, c, rules);
        if (back.flags.some(f => f.severity === 'hard')) continue;
        const dist = Math.abs(j - dayIdx);
        if (!best || dist < best.dist) best = { day: j, code: c, dist };
      }
      if (best) {
        trade = best;
        notes.push({ kind:'trade',
          text:`Trade back — you could take their ${sched.dateLabel(best.day)} ${best.code}` });
      }
    }

    for (const f of flags) {
      notes.push({ kind: f.severity === 'hard' ? 'bad' : f.severity === 'cost' ? 'cost' : 'warn',
                   text: f.text });
    }

    // Scoring. Rest is the only thing weighted heavily against.
    let score = 100;
    if (flags.some(f => f.key === 'rest')) score -= 60;
    if (flags.some(f => f.key === 'rest-tight')) score -= 8;
    score -= Math.max(0, run.length - 5) * 7;
    if (flags.some(f => f.key === 'seventh')) score -= 14;
    if (flags.some(f => f.key === 'weekly-ot')) score -= 9;    // a nudge, not a wall
    if (flags.some(f => f.key === 'double-time')) score -= 6;
    if (flags.some(f => f.key === 'notice')) score -= 4;
    score += Math.min(familiar, 12) * 1.2;
    score += Math.max(0, 20 - load) * 1.1;
    if (trade) score += 18;

    results.push({
      person: p, name: p.name, score: Math.round(score),
      notes, flags, weeklyHours, run, turnaround, familiar, load, trade,
      costly: flags.some(f => f.severity === 'cost'),
      unsafe: flags.some(f => f.severity === 'hard')
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
