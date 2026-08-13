/*
 * calendar.js — put your own shifts in your phone's calendar
 *
 * Generates a standard .ics file in the browser. Apple Calendar, Google
 * Calendar and Outlook all import it, so one file covers everyone without
 * asking anybody to connect an account or grant access to anything.
 *
 * Two details this has to get right, because getting either wrong produces a
 * calendar that looks fine and is quietly incorrect:
 *
 *   Overnight shifts. A 1430-0100 shift ends the *next* day. Writing the end
 *   time without rolling the date makes a ten-hour shift look like it ran
 *   backwards, and most calendar apps will silently drop the event.
 *
 *   The year. Schedule sheets record a month and a day and almost never a
 *   year, so it has to be worked out. Guessing "this year" breaks a December
 *   schedule opened in January. The day-of-week labels resolve it: only one
 *   candidate year makes the dates fall on the right weekdays.
 */

const DOW_INDEX = { Su: 0, M: 1, Mo: 1, T: 2, Tu: 2, W: 3, We: 3, Th: 4, F: 5, Fr: 5, Sa: 6 };

/**
 * Work out which year this schedule belongs to.
 *
 * Anchored on when the file was loaded, not on the current moment. A schedule
 * uploaded in August and exported to a calendar the following February must
 * still resolve to the year it was uploaded in; using "now" would quietly
 * shift every date by a year.
 *
 * Within that anchor, candidate years are scored by how many dates land on the
 * weekday the sheet claims. The right year matches every row and a wrong one
 * matches almost none, so a sheet with day-of-week labels is unambiguous. A
 * sheet without them falls back to whichever candidate sits closest to the
 * load date, which is the same answer in every ordinary case.
 */
export function inferYear(sched, now = null) {
  if (sched.meta && sched.meta.year) return sched.meta.year;
  const anchor = now
    || (sched.meta && sched.meta.loadedAt ? new Date(sched.meta.loadedAt) : new Date());
  const thisYear = anchor.getFullYear();
  const candidates = [thisYear - 1, thisYear, thisYear + 1];
  let best = null;

  for (const y of candidates) {
    let matched = 0, checked = 0, rollover = 0, prevM = null;
    for (const d of sched.dates) {
      const want = DOW_INDEX[d.dow];
      if (want === undefined) continue;
      if (prevM !== null && d.m < prevM) rollover++;   // Dec -> Jan
      prevM = d.m;
      const actual = new Date(y + rollover, d.m - 1, d.d).getDay();
      checked++;
      if (actual === want) matched++;
    }
    const score = checked ? matched / checked : 0;
    const first = sched.dates[0];
    const distance = Math.abs(new Date(y, first.m - 1, first.d) - anchor);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { year: y, score, distance };
    }
  }
  return best.year;
}

/** Absolute date for a schedule index, handling a December-to-January roll. */
export function dateAt(sched, i, year) {
  let rollover = 0, prevM = null;
  for (let k = 0; k <= i; k++) {
    const m = sched.dates[k].m;
    if (prevM !== null && m < prevM) rollover++;
    prevM = m;
  }
  const d = sched.dates[i];
  return { y: year + rollover, m: d.m, d: d.d };
}

const pad = n => String(n).padStart(2, '0');

/** Local "floating" timestamp — no timezone, which is what shift work wants. */
function stamp(y, m, d, mins) {
  const hh = Math.floor(mins / 60) % 24;
  const mm = mins % 60;
  return `${y}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
}

function addDays({ y, m, d }, n) {
  const dt = new Date(y, m - 1, d + n);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

/** iCalendar wants lines folded at 75 octets, continuation lines space-prefixed. */
function fold(line) {
  if (line.length <= 74) return line;
  const out = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) { out.push(' ' + rest.slice(0, 73)); rest = rest.slice(73); }
  if (rest) out.push(' ' + rest);
  return out.join('\r\n');
}

/** iCalendar escaping — distinct from HTML escaping elsewhere in the app. */
function icsEscape(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
                  .replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * Build an .ics containing one person's shifts.
 * Only ever called with the signed-in person, so a file can't leak a roster.
 */
export function buildICS(sched, person, opts = {}) {
  const year = opts.year || inferYear(sched);
  const label = opts.calendarName || 'Work shifts';
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
                  `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const slug = String(person.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shift-board//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${icsEscape(label)}`)
  ];

  let count = 0;
  for (let i = 0; i < sched.n; i++) {
    const code = sched.cell(person, i);
    if (!sched.isWork(code)) continue;
    const span = sched.span(code);
    if (!span) continue;

    const start = dateAt(sched, i, year);
    const endsNextDay = span.end >= 1440;
    const end = endsNextDay ? addDays(start, 1) : start;
    const pos = sched.position(code);

    const desc = [
      pos && pos.label && pos.label !== code ? pos.label : null,
      `${sched.clockHoursOf(code)} hrs on the clock`,
      opts.rules ? `${sched.paidHoursOf(code, opts.rules)} paid hrs` : null
    ].filter(Boolean).join(' \u00b7 ');

    lines.push(
      'BEGIN:VEVENT',
      fold(`UID:${slug}-${start.y}${pad(start.m)}${pad(start.d)}-${icsEscape(code)}@shift-board`),
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${stamp(start.y, start.m, start.d, span.start)}`,
      `DTEND:${stamp(end.y, end.m, end.d, span.end % 1440)}`,
      fold(`SUMMARY:${icsEscape(code)}${opts.prefix ? '' : ' shift'}`),
      fold(`DESCRIPTION:${icsEscape(desc)}`),
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
    count++;
  }

  lines.push('END:VCALENDAR');
  return { ics: lines.join('\r\n') + '\r\n', count, year };
}

/** Hand the file to the browser. Never uploaded; it's built and saved locally. */
export function downloadICS(text, filename) {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
