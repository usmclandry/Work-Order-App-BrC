# Job site work orders

Phone page for a two-person work order list. This repo is the page only. Orders, equipment, and files stay in the private repo `job-site-work-orders`.

Open the published page:

`https://brandonlandry-osc.github.io/job-site-work-orders-app/`

Sign in with:

- Private repo: `BrandonLandry-osc/job-site-work-orders`
- A fine-grained GitHub token that can only read and write that private repo

The token stays in the browser. The page asks GitHub who the token belongs to and stamps every note, status change, file, and assignment with that person. The first two GitHub accounts to sign in become the two people.

Create the token from the private repo's README. Sign out deletes it from this device.

The page has no third-party scripts. `styles.css` and `app.js` are loaded with `?v=2`. `model.js` and `github.js` are loaded with `?v=1`. Raise those numbers when you publish a change so phones pick up the new page.
