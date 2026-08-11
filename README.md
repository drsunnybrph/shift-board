# Shift Board

A shift swap board for hospital departments that still run their schedule out of a spreadsheet.

Post a shift you can't work. The board ranks who can actually cover it — checking rest between
shifts, consecutive days, how full their pay week already is, familiarity with the position, and
whether a trade back is possible. No group text, no reply-all thread, no one manually scanning a
grid to work out who's free.

Static site. No backend, no build step, no accounts.

---

## The data never leaves the browser

This is the part to understand before you use it with a real schedule.

Your workbook is read client-side with [SheetJS](https://sheetjs.com). It is parsed in memory and
never transmitted. There is no server to transmit it to — the whole thing is HTML, CSS, and three
JavaScript modules served as static files.

`.gitignore` blocks `*.xlsx`, `*.xls`, and `*.xlsm` so a real schedule can't be committed by
accident. The repo ships with generated demo data: twenty-five invented names on an invented
six-week rotation.

**Even so, don't publish a real departmental schedule anywhere public.** Staffing levels and leave
patterns are internal information regardless of whether they contain patient data. Run it locally,
or host it behind whatever access control your organisation uses.

---

## Running it

Any static file server. Because it uses ES modules, opening `index.html` directly from the
filesystem won't work — you need `http://`, not `file://`.

```bash
git clone https://github.com/YOURNAME/shift-board.git
cd shift-board
python3 -m http.server 8000
# open http://localhost:8000
```

### GitHub Pages

Settings → Pages → deploy from branch → `main` / root. Live at
`https://YOURNAME.github.io/shift-board/` in a minute or two. No configuration needed.

GitHub Pages is public and indexable. That's fine here — the repo contains only generated demo
data, and any real schedule you load stays in your own browser. Just don't commit a real one.

---

## Loading your schedule

Setup tab → drop in an `.xlsx`. The parser expects the layout most hand-built hospital schedules
already use:

```
        │  Su  M   T   W   Th  F   Sa     ← day-of-week row
        │  16  17  18  19  20  21  22     ← day-of-month row
────────┼────────────────────────────
 NAME 1 │  ED  ED      ICU ICU     PTO
 NAME 2 │      C1  C1  C1      x
```

- **Names** in the first column
- **Day-of-week labels** somewhere in the first dozen rows — this is how the parser finds the grid
- **Day-of-month numbers** on the row directly beneath
- **Position codes** in the cells

It also needs a **legend** pairing each code with its hours. Put it anywhere in the sheet:

```
ICU   0600-1630
ED    1430-0100
N     2030-0700
```

Without the legend the tool can't compute rest between shifts or weekly hours, so it will tell you
the file is missing times rather than guessing.

**Optional:** a second sheet named `Check`, `Staffing`, or `Coverage` with position codes down the
first column and `Yes`/`No` across the dates marks which positions are required each day. Supply it
and the Gaps tab will show unfilled required slots.

Leave codes recognised out of the box: `PTO`, `HOL`, `LOA`, `S`, `VAC`, `CE`, `NEO`.
Neutral "not needed" markers: `x`, `off`, `-`.

---

## Getting someone else set up

There's no account and no invite. You send the URL, they open it, and they land on the sample
department with a banner saying so and a button pointing at the loader. Realistically that's a
five-minute one-time setup on a phone:

1. Save the schedule to the phone first. From Mail or Teams, tap the attachment → **Save to Files**.
2. Open the site → **Schedule** tab → **Choose a file** → pick the xlsx.
3. Pick their name from the dropdown at the top right.
4. **Add to Home Screen** (Safari share sheet, or Chrome's menu). It opens full-screen after that
   and is far easier to find again than a URL in a text thread.

After step 2 the schedule is remembered on that device, so this isn't repeated every time.

**Two caveats worth passing on.** iOS Safari clears site storage for anything not opened in about
seven days, so an occasional user will find themselves re-uploading. And private browsing keeps
nothing at all.

If that's more friction than the person is willing to absorb — which is a completely reasonable
place to land — the honest fallback is that you run it and send them the screenshot. The ranked
list is the valuable part; how it reaches them barely matters.

## How ranking works

Three principles are baked into `assets/engine.js`, and they're the opinionated part:

**A blank cell means "not scheduled," not "available."** Nothing in a schedule grid tells you who
*wants* to work. The tool narrows the field to who isn't already committed; it can't tell you who'll
say yes. If you build on this, the highest-value addition is letting people declare availability
themselves.

**Familiarity is a signal, not a filter.** In a cross-trained department, "hasn't been assigned ED
recently" describes the scheduler's habits, not anyone's competence. Someone who's never appeared on
a position still shows up as a candidate, just ranked lower.

**Overtime is a flag, never a veto.** A short-staffed shift is worse than an expensive one, and
managers make that trade deliberately. Costs are labelled — weekly hours, seventh-day premium — so
the decision is informed. Nobody is removed from the list for being expensive.

Only rest is weighted heavily against, because that one is a safety question rather than a budget
question.

### Configurable in the Setup tab

| Rule | Default | What it does |
|---|---|---|
| Minimum hours between shifts | 8 | Below this, flagged as a rest problem |
| Weekly overtime threshold | 40 | Hours in a pay week before OT applies |
| Long run threshold | 6 | Consecutive days before a stretch reads as heavy |
| Alternative workweek | on | On: 10s and 12s are straight time. Off: daily OT past 8 |
| Seventh-day premium | on | Flags the 7th consecutive day in a pay week |

| Double-time threshold | 12 | Hours in a day before double time |
| Minimum swap notice | 0 (off) | Flags swaps posted inside your policy window |

Defaults lean toward California, which has daily overtime, double time past twelve hours, and a
seventh-day premium that most states don't.

### What is deliberately not modelled

Read this before anyone treats a green result as approval:

- **Collective bargaining terms.** Some contracts require open shifts be offered by seniority, or
  posted for a set window before anyone can claim them. This ranks by fit and cost, which can
  directly contradict a contractual order of offer.
- **Meal and rest break premiums.**
- **Per diem commitment minimums, float and shift differentials.**
- **Competency sign-off.** "Has worked this position before" is an observation about the schedule,
  not a credentialling record. Someone can be qualified and never assigned, or assigned and since
  lapsed.
- **Whether anyone actually wants the shift.**

**These flags are informational. Your payroll, HR, and contract terms govern, not this tool.** The
right use of a flag is as a prompt to check the real policy.

---

## Layout

```
index.html              shell and tab bar
assets/
  styles.css
  app.js                views, sheets, events
  engine.js             Schedule model, flags, ranking   ← the interesting file
  parser.js             xlsx → model, entirely client-side
  demo-data.js          generated fake roster
```

`engine.js` has no DOM dependencies and can be imported on its own for testing or reuse.

---

## This is not a shared board

Worth being blunt about, because it's the thing people assume.

There is no server. Everything — the schedule you load, the shifts you post, your settings — lives
in `localStorage` in one browser on one device. If you send someone the URL, they get their own
separate copy starting from the demo data. They will not see what you posted. You will not see
theirs.

So what it's actually good for right now:

- **Working out coverage fast.** Load the schedule, tap a day, get a ranked list with rest,
  consecutive days, and weekly hours already computed. Screenshot it, send it to whoever needs to
  decide. The analysis is the hard part; the messaging was never the bottleneck.
- **Showing someone the idea** without asking them to imagine it.

Making it genuinely multiplayer means a backend: somewhere to store posts, and auth so only your
department can read them. That is a real project with a real data-handling conversation attached,
because at that point you are storing staffing information on infrastructure someone has to own.
Don't skip that conversation by reaching for the quickest hosted database.

## Other limitations

- Reads one schedule sheet at a time; no multi-department view
- No notifications — "Ask" is a stub, since there's nothing to send from
- Nothing writes back to the source spreadsheet. Approved swaps still get entered by hand
- Availability is inferred from the grid, with the caveat above

---

## Contributing

Issues and pull requests welcome, particularly for other schedule layouts — every department's
spreadsheet is idiosyncratic, and the parser only knows the one shape so far.

Please don't attach real schedules to issues.

## License

MIT. See [LICENSE](LICENSE).
