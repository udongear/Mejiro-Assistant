# Scraping Data

Copies of the race cards captured from TwinSpires with the **Mejiro Capture** bookmark.

The captures themselves are saved to your Mejiro account, so they work on any device, including your phone at the track. To keep a copy here, open **Today's Races → Download CSV** and save the file into this folder.

- Each download holds **every day you've captured so far**, one row per horse: `date, track, track_code, race, pp, horse, starts, wins, places, shows, scratched, captured_at`.
- Capturing a race again replaces its earlier version, so the newest download always has the latest data. You can delete older downloads.
- `starts`, `wins`, `places` and `shows` are blank when the capture couldn't read that horse's record, and `0` for a debut.
