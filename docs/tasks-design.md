# One task model (agreed 2026-11-23)

Everything in Life is a task: habits, medications, Home maintenance, dinners, trip bookings and
activities, credit card credits, people dates (birthdays, anniversaries, catch-ups), and calendar
events (read-only, synced from Apple). Tabs stay as views over the same tasks.

## The task pop-up (same for every kind)

1. **Header**: kind icon, title, one status line, and a streak pill on the right ("83 🔥", gray at 0).
2. **Main action**: one big button that fits the kind (Done, Taken, Used $15, Booked), with two
   smaller ones under it (skip this time, snooze; credits: "Used part…", "Not this month").
3. **Details**: the only section that differs by kind (dose; room / DIY / time; card / amount;
   person / occasion; trip; time / location).
4. **Schedule** (Apple Reminders style):
   - Date toggle and date; Time toggle and time (optional).
   - Repeat: Never, Daily, Weekly, Biweekly, Monthly, Quarterly, Semi-annually, Yearly, **Custom**.
     Custom opens the preset-chip picker from the medication form (2× a day, chosen weekdays,
     chosen dates, every N days / weeks / months).
5. **Reminders**: "Nag until done" toggle. When on, how often:
   - **Hourly**
   - **Daily** at a time you pick
   - **Weekly** on a day you pick (and time)
   - plus who it's for (me / the other person / both).
   Credits nag in the days before they end (the money is gone after).
6. **History** (bottom): strip of recent periods (done / partly done / skipped), last completion,
   best streak, "All ›" for the full list.
7. Remove (left) and Edit (right).

## Streaks

- Count of consecutive scheduled occurrences completed with the **main (top) button**
  (Done / Taken / Used / Booked). Only that button counts.
- Skip and Snooze never add to the streak. An occurrence that ends without the main button
  (skipped, or left undone) breaks it. Snoozing then finishing with the main button in the same
  occurrence still counts.
- Credits: any use in the period counts, including "Used part…" (the history strip still shows a
  partly used period as a half box).

## Build order

1. Foundation: one task table, one completion log, one schedule engine (based on public/meds.js),
   one reminder engine, and the shared pop-up. Move **habits** first.
2. Medications, then Home, then people dates.
3. Credits, then dinners, then trips as groups of tasks.
4. One combined Today list.

Each step ships on its own after the full screen check; data moves over with nothing lost.
