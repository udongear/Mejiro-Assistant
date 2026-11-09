# Scraping Data

Copies of the race cards captured from TwinSpires with the **Mejiro Capture** bookmark.

The captures themselves are saved to your Mejiro account, so they work on any device, including your phone at the track. To keep a copy here, open **Today's Races → Download CSV** and save the file into this folder.

- Each download holds **every day you've captured so far**, one row per horse: `date, track, race, pp, horse, starts, wins, places, shows, ml_odds, scratched, captured_at`.
- Capturing a race again replaces its earlier version, so the newest download always has the latest data. You can delete older downloads.
- `starts`, `wins`, `places` and `shows` are blank when the capture couldn't read that horse's record, and `0` for a debut.
- `ml_odds` is the morning line as odds to 1: `4.5` is 9/2, `8` is 8-1, `1` is even money. It's written as a number because spreadsheets turn "9/2" into a date. Blank when the capture didn't find one (captures from before the bookmark read morning lines have none).
