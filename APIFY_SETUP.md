# First race times with Apify

An Apify "Actor" (a ready-made scraper) reads today's race cards from Equibase every morning. Mejiro Assistant fetches the results and shows each track's first post time under **Racing today**.

> Equibase's terms forbid automated access. Scraping one small page set a day for personal use is low-risk, but it's your call.

## 1. Create an Apify account

Sign up at https://apify.com (free; "Sign up with Google" works). The free plan includes a small monthly credit, which should cover this (see step 7).

## 2. Try the scraper

1. Open **Equibase Horse Racing: Entries, Results & Payouts**: https://apify.com/getascraper/equibase-us-horse-racing-scraper and click **Try for free**.
2. Fill in the input:
   - **Race date:** leave blank (means today)
   - **Track codes:** leave blank (all tracks)
   - **Data mode:** `entries`
   - **Race numbers:** `1` (only the first race at each track, which keeps it cheap)
   - **Max items:** `100`
3. Click **Start**. When it finishes, open the **Output** tab and check that rows show a **postTime** like `12:30 PM`.

If postTime is empty, use https://apify.com/jungle_synthesizer/equibase-us-horse-racing-scraper instead, with **Data mode** `entries` and **Max items** `400`. That one has no race-number filter, so it returns every race and costs a little more; Mejiro picks the earliest race per track automatically.

## 3. Save it as a task

At the top of the input page, click **Save as a new task** and name it `Mejiro first races`.

## 4. Run it every morning

**Schedules → Create new.** Set it to run daily at **7:00 AM** in the `America/New_York` time zone (before the earliest first posts), then **Add** your `Mejiro first races` task to it and save.

## 5. Build the results link

The link Mejiro reads looks like this:

```
https://api.apify.com/v2/actor-tasks/TASK_ID/runs/last/dataset/items?token=YOUR_TOKEN&status=SUCCEEDED&clean=true
```

- **TASK_ID:** open your task; it's the part of the address after `/tasks/` (e.g. `console.apify.com/actors/tasks/AbC123xyz/input` → `AbC123xyz`).
- **YOUR_TOKEN:** **Settings → API & Integrations → Personal API tokens**, copy your token.

Paste the link into your browser once. You should see a list of races with post times.

## 6. Connect it to Mejiro Assistant

Sign in, go to **Settings → First race times**, paste the link, and click **Save settings**. Racing today now shows times (and **LIVE** once a card starts). It re-checks every 30 minutes while the page is open.

The token in the link works like a password for your Apify account. Mejiro saves it only in your private account data, never in the website's files. Don't post the link anywhere public. If it leaks, delete the token in Apify and make a new one.

## 7. Cost

With race 1 only, each day is one record per Thoroughbred track racing (usually 10–30). That's roughly 300–900 records a month, which at the listed $4.60 per 1,000 records is about $1.50–$4 a month. Check the Actor's **Pricing** tab for current rates.

## Limits

- **Breeds:** Equibase covers Thoroughbred racing (and some Quarter Horse cards), so harness tracks keep showing "Time TBA".
- **Track names:** Mejiro matches tracks by name and code. If a track that races today shows no time while others do, its name differs between the two sources and needs a small fix.
- **LIVE:** a card counts as LIVE from first post until 5 hours later.
