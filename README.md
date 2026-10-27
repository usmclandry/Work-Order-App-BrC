# Job site work orders

Phone page for a two-person work order list. The layout is the Broussard Campus page: search, current orders, New order, and Orders / Equipment. Dark mode is in the settings gear.

Orders, equipment, notes, and files are stored in Supabase. The page has no third-party scripts. It talks to Supabase with `fetch`.

## Connect a free Supabase project

1. Create a project at [supabase.com](https://supabase.com) on the Free plan.
2. Open the SQL editor and run `supabase/schema.sql`.
3. Under Authentication → Users, add each person with email and password. The app allows 10. Turn on "Auto Confirm User" for each.
4. Under Authentication → Sign In / Providers → Email, turn off "Allow new users to sign up".
5. Under Project Settings → API, copy the project URL and the anon public key into `config.js`:

```js
window.JOB_SUPABASE = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-KEY"
};
```

The anon key is meant to be in this page. Database rules still require a signed-in person. Do not put the service-role key in this repo or in the page.

`styles.css` is loaded with `?v=13`, `config.js` with `?v=2`, `model.js` with `?v=2`, `supabase.js` with `?v=1`, and `app.js` with `?v=13`. Raise those numbers when you publish a change so phones pick up the new page. Dark mode is stored on the phone as `jsw.theme`.

The first account to sign in can create work orders and budgets. Later accounts cannot until that is turned on in Settings. An eleventh sign-in is refused. Sign out clears the session from this phone.
