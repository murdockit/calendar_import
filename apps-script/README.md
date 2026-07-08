# Gmail → Shared Google Calendar Flyer Extractor

A standalone Google Apps Script that watches a Gmail label for forwarded flyers
(photos, PDFs, or plain-text event emails), extracts events with the Gemini
API, and creates them on a shared Google Calendar — no server required.

## How it works

Every 15 minutes, `processFlyerInbox()` runs and:

1. Searches Gmail for `label:flyers -label:flyers-processed -label:flyers-failed`.
2. For each unprocessed message, sends its image/PDF attachments (or, if none,
   the plain-text body) to the Gemini API with a structured-output schema
   asking for an array of events (`title`, `date`, `start_time`, `end_time`,
   `location`, `notes`, `confidence`, `source_text`).
3. Creates each valid event on your shared calendar, skipping anything that
   looks like a duplicate (same title on the same day).
4. Labels the message `flyers-processed` (or `flyers-failed` after repeated
   failures) and sends you one summary email listing what was created,
   skipped, flagged low-confidence, or errored.

## 1. Create the script

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Rename the project (e.g. "Flyer Calendar Extractor").
3. Delete the default `Code.gs` content.
4. For each file in this `apps-script/` folder — `main.gs`, `gemini.gs`,
   `calendar.gs`, `summary.gs` — create a matching script file (**+ → Script**)
   and paste the contents in.
5. Open **Project Settings** (gear icon) → check **"Show appsscript.json manifest
   file in editor"**. Open `appsscript.json` in the editor and replace its
   contents with the one in this folder. Set `timeZone` to your own IANA
   timezone (e.g. `America/Chicago`) — and update the `TIMEZONE` constant at
   the top of `main.gs` to match.

## 2. Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key**
   → **Create API key**.
2. The free tier is sufficient for personal flyer volume. Copy the key.

## 3. Set Script Properties

In the Apps Script editor: **Project Settings** → **Script Properties** →
**Add script property**. Add:

| Property | Required | Value |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Your Gemini API key from AI Studio |
| `CALENDAR_ID` | Yes | See step 4 below |
| `GEMINI_MODEL` | No | Defaults to `gemini-2.5-flash`. Bump to a Pro model (e.g. `gemini-2.5-pro`) if extraction quality on messy/handwritten flyers isn't good enough — it's slower and costs more, but reads harder images better. If you see a `429` with `"limit": 0` for a given model, your API key's free tier doesn't have quota for that model — switch to a different one (check current free-tier models/limits at [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)). |
| `GMAIL_QUERY` | No | Defaults to `label:flyers -label:flyers-processed -label:flyers-failed` |
| `MAX_MESSAGES_PER_RUN` | No | Defaults to `5` |
| `SUMMARY_EMAIL` | No | Defaults to the script owner's email |
| `CALENDAR_MAP` | No | JSON object routing events to different calendars by an alias in the subject line — see "Multiple calendars" below |

## 4. Find your shared calendar's ID

1. In [Google Calendar](https://calendar.google.com), find your shared
   calendar in the left sidebar → hover → **⋮** → **Settings and sharing**.
2. Scroll to **Integrate calendar** → copy the **Calendar ID** (looks like
   `abc123...@group.calendar.google.com`, or your email address if it's a
   personal calendar shared with edit access).
3. Paste it as the `CALENDAR_ID` script property above.

The script deliberately does **not** default to your primary calendar — it
fails loudly if `CALENDAR_ID` isn't set, so events can't accidentally land in
the wrong place.

### Multiple calendars (optional)

If you have more than one shared calendar (e.g. one per kid, per household
member, or per activity type — visible in the screenshot as "Chloe",
"Lydia", "Family", etc.), you can route a forwarded flyer to a specific one
by tagging the subject line, using the `CALENDAR_MAP` script property.

1. Get the Calendar ID for each calendar you want to target (repeat step 4
   above for each one).
2. Set `CALENDAR_MAP` to a JSON object mapping a short alias to each Calendar
   ID, e.g.:

   ```json
   {"chloe": "abc123...@group.calendar.google.com", "lydia": "def456...@group.calendar.google.com"}
   ```

3. When forwarding a flyer, put the alias in brackets anywhere in the subject,
   e.g. `Fwd: [Chloe] Soccer schedule`. The script checks (case-insensitively):
   - a bracketed tag like `[chloe]` first,
   - then a plain substring match of any alias in the subject,
   - and falls back to the default `CALENDAR_ID` if nothing matches.

Events created and duplicate-skips in the summary email note which calendar
they landed on, e.g. `Soccer practice — 2026-08-01 (all day) [Chloe]`.

#### Troubleshooting routing

If tagged events keep landing on the default calendar:

- **Deploy both files.** `CALENDAR_MAP` is read in `main.gs` (not
  `calendar.gs`) — re-paste **both** `main.gs` and `calendar.gs` whenever you
  update.
- **Strict JSON.** The property value must use double quotes and no trailing
  commas: `{"chloe": "id1", "lydia": "id2"}`. Invalid JSON makes the whole run
  fail with a clear error; a *misspelled property name* (e.g. `CALENDER_MAP`)
  silently yields no routing.
- **Calendar IDs, not names.** Values must be the ID from Settings →
  Integrate calendar (`...@group.calendar.google.com`), not the calendar's
  display name.
- Aliases are matched case-insensitively, so `[Lydia]`, `[lydia]`, and a map
  key of `"Lydia"` all work together.
- **Run `debugCalendarRouting()`** from the Apps Script editor (edit its
  `TEST_SUBJECT` to your subject line). It logs the raw and parsed map,
  verifies every calendar ID actually opens, and shows exactly where the test
  subject would route.
- Routing misses are also reported in the summary email: if a subject has a
  bracket tag that matches no alias, you'll see a warning line instead of a
  silent fallback.

## 5. Authorize and install the trigger

1. In the Apps Script editor, select the `installTrigger` function from the
   function dropdown (top toolbar) and click **Run**.
2. The first run will prompt you to authorize the script — grant access to
   Gmail, Calendar, and external requests (this is the Gemini API call).
3. This creates a time-driven trigger that calls `processFlyerInbox()` every
   15 minutes. You can verify it under the clock icon (**Triggers**) in the
   left sidebar.
4. Re-running `installTrigger()` is safe — it removes any existing trigger for
   `processFlyerInbox` first, so you won't get duplicates.

## 6. Set up the Gmail label and filter

1. In Gmail, create a label called `flyers` (Settings → Labels → Create new
   label, or it'll be auto-created the first time the script runs).
2. Create a filter so flyers land there automatically: Gmail search bar →
   dropdown arrow → enter criteria, e.g.:
   - `from:your-wifes-address@example.com` (so anything she forwards is
     labeled), or
   - `to:you+flyer@gmail.com` (a Gmail "plus address" — she forwards to
     `you+flyer@gmail.com` instead of your normal address).
3. Under **Create filter**, check **Apply the label: `flyers`**.
4. She just forwards flyers to your Gmail as normal — no second Google account
   or setup needed on her end.

## 7. Try it

Forward yourself a flyer (photo, PDF, or a plain-text event email) with the
`flyers` label applied (either via the filter or manually). Within 15 minutes:

- The events should appear on your shared calendar.
- You should get a summary email listing what was created.
- The message gets labeled `flyers-processed`.

You can also run `processFlyerInbox()` manually from the editor to test
immediately instead of waiting for the trigger.

## Notes & tradeoffs

- **Retries**: a message whose extraction wholly fails keeps the `flyers`
  label and is retried on the next run, up to 3 attempts (tracked via a script
  property counter per message ID). After the 3rd failure it's moved to
  `flyers-failed` so it stops retrying forever; you can manually re-label it
  back to `flyers` to try again (e.g. after fixing a bad API key). If only
  some of a message's attachments fail, the message still counts as processed
  (retrying would duplicate the successful ones) — the failures are just
  reported in the summary.
- **Quota exhaustion**: if the Gemini API reports quota/rate exhaustion
  (HTTP 429), the run pauses immediately instead of failing every message —
  nothing is penalized or moved to `flyers-failed`, and everything left over
  simply retries on the next 15-minute run.
- **Duplicates**: re-forwarding the same flyer is safe — before creating an
  event, the script checks for an existing event with the same title on the
  same day and skips it if found.
- **Thread granularity**: processed/failed state is tracked per Gmail
  *thread*. Gmail threads a re-forward with the identical subject into the
  already-processed conversation, so it gets skipped. If you actually want a
  flyer re-processed (e.g. an updated version), tweak the subject line when
  forwarding, or remove the `flyers-processed` label from the thread.
- **No recurring events**: a flyer that says "every Tuesday in April" will
  produce whichever discrete dates Gemini extracts, not a recurrence rule.
- **Rate limits**: attachments are processed sequentially (not in parallel) to
  stay within Gemini free-tier rate limits, and a 5xx gets one retry with
  backoff before being reported as an error for that attachment.
- **Thinking budget**: the request disables Gemini "thinking"
  (`thinkingConfig: { thinkingBudget: 0 }`), which 2.5-series models support.
  If you set `GEMINI_MODEL` to an older model that rejects `thinkingConfig`
  (e.g. 2.0-era), remove that line from `gemini.gs`.
- **Secrets**: the Gemini API key lives only in Script Properties, sent via
  the `x-goog-api-key` header (never in the URL or logs).

## If you use `clasp`

If you'd rather push these files with the [clasp](https://github.com/google/clasp)
CLI instead of copy-pasting:

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "Flyer Calendar Extractor" --rootDir ./apps-script
clasp push
```

Then set the Script Properties and run `installTrigger()` from
[script.google.com](https://script.google.com) (or `clasp run installTrigger`
after enabling the Apps Script API) as in steps 3–5 above.
