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

## Two directions

**Give one up** — you can't work a shift, and the board ranks who could cover it.

**Want a shift** — the per diem direction, in three steps. Mark the days you can work, pick the
shifts you want, and the tool assembles the whole request into one plan: who to ask, what each
person gets in return, and your net hours. Where a shift is already held by someone on a benefited line,
taking it costs them real hours, so it works out how they come out whole and ranks the options:

- **A shift back** — they take one of yours. Hours unchanged on both sides.
- **A three-way relay** — they take a shift from a third person who wants to give it up. This is
  the shape most real swaps take, because the person with hours to spare is rarely the person
  asking. A shift already posted on the board is the strong case; anything else is flagged as
  needing that third person's agreement, since it moves the lost hours onto them.
- **An open shift instead** — they pick up an unfilled required position. Hours unchanged, and the
  department ends up better covered than it started.
- **PTO** — their shift stays covered because you're working it, but they spend accrued balance.
  Ranked last: it's the only option that costs them something they can't get back.

Every plan is checked so no required position ends the day empty. A plan that fills your shift by
emptying another one is not a plan, and won't be shown.

### Availability from cell colour

Many hand-built schedules record per diem availability as a fill colour, which is information that
exists nowhere in the cell text. The parser reads it, including theme-indexed colours, which arrive
as an index plus a tint rather than a hex value and have to be resolved against the workbook theme.

Telling a marking system apart from decoration matters here: weekend shading and a closed-clinic
colour look identical to availability if you only count cells. The test used is whether the marked
columns *vary between people*. Decoration paints the same columns for everybody; availability
differs person to person.

When a sheet encodes availability, it prefills, and everyone's availability is respected when
ranking who can cover a shift — so the planner won't propose a shift to someone who already said
they're not around. What you set in the app always wins over what the sheet says.

When a sheet encodes nothing, availability is declared rather than inferred: a blank cell means
"not scheduled", which says nothing about whether that person is free. You tap the days you can
work, stored on your device only.

When you request several shifts at once, plans are reconciled against each other: the same
give-back shift is never promised twice, and you can't end up picking up two shifts on the same
day. Anything that can't be made to work is called out rather than quietly dropped.

### Choosing, and saying so

The ranking is a suggestion, not a decision. Tap any plan to choose it and that choice survives
recomputation — the tool will work the rest of the request around it rather than overriding it.

Where the ranking can't know something, you can tell it. If a colleague actually wants time off,
mark them, and relays through their shifts stop reading as "this costs them hours" and start
reading as what they are: the thing that person was already after. That marking is per person, so
if they want *specific* days off, choose those plans by hand.

The finished plan copies two ways. The group-chat version opens with what each person gets, because
that's what they'll decide on. The manager version is dates, codes, and the coverage assurance.

## Getting your shifts into your phone

The Mine tab has a button that downloads a standard `.ics` file. Apple Calendar, Google Calendar
and Outlook all import it, so nobody has to connect an account or grant access to anything.

Only the signed-in person's own shifts go in the file, and it's generated in the browser like
everything else here — a roster can't leak out of it.

Two details it gets right that are easy to get wrong:

- **Overnight shifts.** A 1430-0100 shift ends the *next* day. Writing the end time without rolling
  the date makes the event run backwards, and most calendar apps silently drop it.
- **The year.** Schedule sheets record a month and a day and almost never a year, so it has to be
  worked out — and it's anchored to **when the file was loaded**, not to the current moment. A
  schedule uploaded in August and exported to a calendar the following February must still resolve
  to the year it was uploaded in; using "now" would quietly shift every date by a year. Within that
  anchor, the day-of-week labels settle it: only one candidate year makes the dates fall on the
  right weekdays, which also handles a December schedule opened in January.

  The resolved year is shown next to the button and can be overridden. Inference that can't be
  seen or corrected is worse than no inference.

Events use floating local time with no timezone attached, which is what shift work wants: 1430 means
1430 where you are, not converted from anywhere.

## Sick calls

A different problem from a planned swap, with different rules.

A planned swap can afford to only consider people who marked themselves available. A sick call
can't — the shift starts in a few hours and somebody has to be on it. So the Sick call tab shows
everyone who isn't already committed, sorted into who's worth calling first rather than filtered
down to them:

- **Said they're available** — marked available and not working
- **Not working, didn't mark availability** — no commitment that day, they just never said
- **Free, but the timing is rough** — could physically do it, but it cuts into rest or makes a long run
- **On approved leave** — booked time off, last resort

Someone the sheet marks unavailable still appears, labelled, below those who said nothing. In a
sick call you want the whole list; hiding people is how a shift ends up uncovered.

Overtime is marked and never disqualifying. Rest problems get their own tier, because someone
finishing at 0100 shouldn't be first pick for an 0630 however urgent the call is — that's a safety
question rather than a budget one.

The list copies as text for whatever channel the coordinating happens in.

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

### FTE, and why it has to be typed in

Giving up a shift only costs someone PTO if it drops them **below their contracted hours**.
Somebody at 0.5 FTE scheduled for 30 hours that week can hand a shift back and still be over
contract — it costs them nothing, and calling it a PTO day is simply wrong.

FTE appears nowhere in a schedule, and it can't be inferred from one. On a real sheet, a 0.5 FTE
pharmacist's scheduled hours implied 0.88, and a per diem's implied 0.58. Inference here doesn't
just fail, it fails confidently, which is worse.

So it's recorded by hand — in the Setup tab for everyone at once, or on the plan whose cost depends
on it. Anyone left unset stays unknown, and the tool says so rather than assuming the worst.

### Paid hours vs clock hours

These are not the same number and the difference decides whether overtime exists.

A 1430-0100 shift is **10.5 hours on the clock** but **10 hours on the payslip**, because the meal
period sits inside the shift unpaid. Four of them in a week is 40 paid hours — not overtime. A tool
that computes overtime off clock time invents penalty pay that isn't there, and computes PTO
balances people never accrued.

So the split is:

- **Paid hours** drive overtime, PTO, and every hour total shown.
- **Clock hours** drive rest between shifts, because that's how long someone is actually away.

The meal period is configurable — length, and the shift length it applies above. Departments with a
second meal period for longer shifts can set `secondBreakAfterHours` in `DEFAULT_RULES`. Check
yours; the defaults are a starting point, not your employer's policy.

### Configurable in the Setup tab

| Rule | Default | What it does |
|---|---|---|
| Unpaid meal period | 30 min | Time inside a shift that isn't paid |
| Meal applies above | 5 hrs | Shorter shifts are paid at full clock time |
| Full-time week | 40 paid hrs | What 1.0 FTE means, for working out hours at risk |
| Alternative workweek | on | An adopted AWS; off means daily overtime starts at 8 |
| AWS shift length | 10 paid hrs | Under the AWS, paid hours in a day past this are overtime |
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
