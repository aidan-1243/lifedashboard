# Life Dashboard: setup guide

The app is a Cloudflare Worker (free plan). It has a small database, runs a check every
15 minutes, and sends notifications to your iPhone through the free **ntfy** app.

Node.js is installed at `~/.local/node`. In Terminal, run this once per window before
the commands below:

```bash
export PATH=$HOME/.local/node/bin:$PATH && cd ~/Documents/Claude/life-dashboard
```

---

## 1. Try it locally (already set up)

```bash
npx wrangler dev --test-scheduled
```

Open http://localhost:8787. The local password is the `APP_TOKEN` line in `.dev.vars`.
The local database holds test data only.

## 2. Get notifications on your iPhone

1. Install **ntfy** from the App Store.
2. Tap **+** and subscribe to your topic. Use the `NTFY_TOPIC` value from `.dev.vars`,
   or make a new one: any long random name works, e.g. `life-` followed by 24 random letters.
3. Allow notifications when iOS asks.

> Privacy note: on the free public ntfy.sh server, anyone who knows your topic name can
> read its notifications. That's why the name is long and random: keep it to yourself.
> Notifications show task titles, not your calendar or contact details.

## 3. Put it online (Cloudflare, free)

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. Sign in from Terminal (this opens your browser):
   ```bash
   npx wrangler login
   ```
3. Create the database, then paste the `database_id` it prints into `wrangler.toml`:
   ```bash
   npx wrangler d1 create life-dashboard
   ```
4. Create the tables:
   ```bash
   npm run db:remote
   ```
5. Set your two secrets. Pick a strong password for APP_TOKEN, and use your ntfy topic name:
   ```bash
   npx wrangler secret put APP_TOKEN
   ```
   ```bash
   npx wrangler secret put NTFY_TOPIC
   ```
   Also add an ntfy access token (strongly recommended). Without one, ntfy.sh counts limits
   against Cloudflare's shared outgoing IP addresses, which other apps use up, and it then
   silently stops pushing to iPhones. Create a free account at ntfy.sh, go to Account ›
   Access tokens › Create, then paste the token here:
   ```bash
   npx wrangler secret put NTFY_TOKEN
   ```
6. Deploy:
   ```bash
   npm run deploy
   ```
   It prints your URL, like `https://life-dashboard.<your-name>.workers.dev`.
7. Put that URL into `PUBLIC_URL` in `wrangler.toml`, then run `npm run deploy` again.
   The Done and Snooze buttons on notifications need this.
8. On your iPhone, open the URL in Safari. Tap **Share › Add to Home Screen**, then sign
   in with your APP_TOKEN.

## 4. Load your contacts (one time)

1. On your Mac, open **Contacts**, choose **All Contacts**, and press ⌘A.
2. Choose **File › Export › Export vCard…** and save the file.
3. In the app, go to **Settings › Import contacts** and choose that file.

Running it again later updates existing people; it doesn't create duplicates. Then open
anyone you want to keep in touch with and set **Check in** (every 2 weeks, monthly, and so on).

## 5. Calendar sync (Apple Shortcut, private)

Your calendar stays private: no public link. A Shortcut on your iPhone sends the next 14
days of events to the app.

In the **Shortcuts** app, create a new shortcut named "Sync Life Calendar":

1. **Find Calendar Events** where *Start Date* is in the next *14 days*. Sort by Start Date, limit off.
2. **Repeat with Each** item in Calendar Events:
   - **Text**: `[Start Date]|[End Date]|[Is All Day]|[Title]`
     - Tap each date variable and set its format to **ISO 8601**.
3. After the loop: **Combine Text** using *Repeat Results*, separated by **New Lines**.
4. **Get Contents of URL**:
   - URL: `https://<your-url>/api/events/sync`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your APP_TOKEN>`, and `Content-Type` = `text/plain`
   - Request Body: **File**, set to *Combined Text*

Then go to **Automation › New › Time of Day**, pick 6:30 AM daily, set it to
**Run Immediately**, and choose this shortcut. Run it once by hand to check: the
Today screen should show your events.

Each line looks like `2026-11-24T14:00:00-06:00|2026-11-24T15:00:00-06:00|No|HOA board call`.

**Shared calendar.** End each line with `|cal:` and the event's *Calendar* name, like
`...|No|Dinner with the Smiths|Their place|cal:Aidan & Logan`. Events on the calendar named in
Settings › Calendar › Shared calendar (default "Aidan & Logan") show up for both people; every
other calendar stays private to whoever synced it. Lines without `cal:` still work (private).

## 6. Wayfare booking reminders

Ask Claude to "sync Wayfare to my Life Dashboard". It reads your Wayfare trips and sends
anything still unbooked to:

```
POST /api/sync/items
{"source": "wayfare", "items": [{"external_id": "...", "title": "Book Costa Rica hotel", "due_at": "2026-12-01T15:00:00Z"}]}
```

Synced items nag hourly once they're past due, with **Booked** and **Tomorrow** buttons.
Running the sync again updates items instead of duplicating them. Send `"done": true` to close one.

---

## How reminders behave

| Setting | What happens once it's due |
|---|---|
| No reminder | Shows in the app only |
| Remind once | One notification |
| Hourly till done | A notification every hour until you tap **Done** (dismissing doesn't stop it) |
| Every 15 min till done | Same, every 15 minutes |

- **Quiet hours** (default 10pm to 7am) pause all nags. Change them in Settings.
- The **morning briefing** (default 7am) lists today's events, birthdays within a week,
  who's overdue for a check-in, and anything still nagging.
- **Repeats every N days** (e.g. HVAC filter every 90): tapping Done moves the due date
  forward instead of closing the item.

## Quick capture keywords

Type naturally in the box at the top. The app picks up:

- **Dates:** today, tomorrow, a weekday ("tues"), "in 3 days", "12/5", "at 3pm"
- **Nagging:** "keep bugging me", "nag me", "hourly", "every 15"
- **Areas:** HOA words (board, pool, dues…), travel (flight, hotel, book…), home (filter,
  gutters, repair…), work (client, office…), people (birthday, call, gift…)
- **People:** any name from your contacts
- **Notes:** start with `note:` or `idea:`

You can change anything afterward by tapping the item.

---

## 7. "Hey Siri, add to Life" (and Apple Watch)

Uses the same Cloudflare key as the calendar Shortcut. That key can only send
calendar events and add captures; it can't read anything.

New shortcut, named **Add to Life**:
1. **Dictate Text** (Stop Listening: After Pause)
2. **Get Contents of URL**
   - URL: `https://life-dashboard.lifedash-dxuk.workers.dev/api/capture`
   - Method: POST
   - Headers: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Content-Type` = `text/plain`
   - Request Body: File → *Dictated Text*
3. **Speak Text** → *Contents of URL* (Siri reads back what was added)

In the shortcut's details (ⓘ), turn on **Show on Apple Watch**. Say
"Hey Siri, Add to Life", then speak naturally: "call mom tomorrow at 6pm, keep bugging me".

## 8. Leave-by alerts (calendar locations)

In **Sync Life Calendar**, change the Text line inside the repeat to:
`[Start Date]|[End Date]|[Is All Day]|[Title]|[Location]`
Events with a location get a "Leave by…" notification using your usual travel
time (Settings › Leave-by alerts). Optional: add `|[minutes]` at the end with a real
travel time from the **Get Travel Time** action.
