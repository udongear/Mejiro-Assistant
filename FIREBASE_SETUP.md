# Putting Mejiro Assistant on Firebase

The code is ready. These steps happen in your Firebase account, so they're yours to do once.

## 1. Create the project

1. Go to https://console.firebase.google.com and click **Create a project**. Name it (e.g. `mejiro-assistant`). Google Analytics is optional; you can turn it off.
2. On the project home page, click the **Web** icon (`</>`) to add a web app. Give it a nickname and register it.
3. Firebase shows a `firebaseConfig = { ... }` block. Copy its six values into **`firebase-config.js`** in this folder.
4. Open **`.firebaserc`** and replace `YOUR_FIREBASE_PROJECT_ID` with your project ID (shown in Project settings).

## 2. Turn on Google sign-in

**Build → Authentication → Get started → Sign-in method → Google →** Enable, choose your support email, **Save**.

`localhost` and your `*.web.app` / `*.firebaseapp.com` addresses are already allowed to sign in. If you add a custom domain later, add it under **Authentication → Settings → Authorized domains**.

## 3. Create the database

**Build → Firestore Database → Create database.** Pick a location near you (for example `us-west1`; it can't be changed later), then **Start in production mode**. The real access rules come from `firestore.rules` when you deploy: each person can only read and write their own data.

## 4. Install the Firebase command-line tool

Either:
- Install Node.js (LTS) from https://nodejs.org, then run `npm install -g firebase-tools`, or
- Download the standalone Windows version from https://firebase.tools (no Node needed).

Then, in this folder, run `firebase login`.

## 5. Try it, then publish

```
firebase emulators:start --only hosting     # serves the site at http://localhost:5000
firebase deploy --only hosting,firestore:rules
```

The test server uses your real sign-in and database, so anything you log there is saved to your account. After deploying, the site is live at `https://<project-id>.web.app`.

## Bringing over the bets saved before accounts

Browsers keep saved data separately per address, so the hosted site can't see what this computer saved when you opened `index.html` from disk.

1. Open `index.html` straight from disk. Under the sign-in button, click **Download data saved in this browser**.
2. Sign in on the hosted site, then go to **Settings → Restore backup** and choose that file.

## Updating the race calendar

Run `mejiro-calendar\Sync Calendar.bat` (needs Python), then `firebase deploy --only hosting`.

## Where the data lives

| Firestore path | Holds |
|---|---|
| `users/{uid}` | settings, Risk Matrix, Calendar and win-rate choices |
| `users/{uid}/bets/{betId}` | one document per bet |

Firestore's free tier is far more than one person's betting log needs.
