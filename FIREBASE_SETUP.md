# Putting Mejiro Assistant online

Firebase handles **Google sign-in** and the **database** (each account's bets and settings). Everything there is done in the Firebase console, with no tools to install. The website itself goes on **Netlify** by dragging a folder into the browser.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com and click **Create a project**. Name it (e.g. `mejiro-assistant`). Google Analytics is optional; you can turn it off.
2. On the project home page, click the **Web** icon (`</>`) to add a web app. Give it a nickname and register it. Leave "Firebase Hosting" unticked.
3. Firebase shows a `firebaseConfig = { ... }` block. Copy its six values into **`firebase-config.js`** in this folder.

## 2. Turn on Google sign-in

**Build → Authentication → Get started → Sign-in method → Google →** Enable, choose your support email, **Save**.

## 3. Create the database and paste the rules

1. **Build → Firestore Database → Create database.** Pick a location near you (for example `us-west1`; it can't be changed later), then **Start in production mode**.
2. Open the **Rules** tab, replace everything in the editor with the contents of **`firestore.rules`** from this folder, and click **Publish**. These rules let each person read and write only their own data.

## 4. Publish the website on Netlify

1. Double-click **`Build Site.bat`**. It copies just the website files into a folder called **`site`**, leaving the calendar database and scripts out.
2. Go to https://app.netlify.com/drop, sign up (free; without an account the site is deleted after an hour), and drag the **`site`** folder onto the page.
3. Netlify gives the site an address like `https://something-random.netlify.app`. You can rename it under **Site configuration → Change site name**.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain**, and enter that address without `https://` (e.g. `mejiro-assistant.netlify.app`). Sign-in won't work from the site until you do this.

**To update the site later** (after changing code or the calendar): run `Build Site.bat` again, then in Netlify open your site → **Deploys**, and drag the new `site` folder onto the "Drag and drop" area.

## Testing on your computer first (optional)

Sign-in doesn't work from `index.html` opened straight from disk; it needs a web address. In VS Code, install the **Live Server** extension, right-click `index.html` → **Open with Live Server**, then change `127.0.0.1` in the address bar to `localhost` (Firebase allows `localhost` by default). Anything you log there saves to your real account.

## Bringing over the bets saved before accounts

Browsers keep saved data separately per address, so the online site can't see what this computer saved when you opened `index.html` from disk.

1. Open `index.html` straight from disk. Under the sign-in button, click **Download data saved in this browser**.
2. Sign in on the online site, then go to **Settings → Restore backup** and choose that file.

## Updating the race calendar

Run `calendar\Sync Calendar.bat` (needs Python), then `Build Site.bat`, and drag the new `site` folder onto Netlify.

## Where the data lives

| Firestore path | Holds |
|---|---|
| `users/{uid}` | settings, Risk Matrix, Calendar and win-rate choices |
| `users/{uid}/bets/{betId}` | one document per bet |

Firestore's free tier is far more than one person's betting log needs.
