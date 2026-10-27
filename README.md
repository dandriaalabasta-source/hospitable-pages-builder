# Hospitable Pages

A website for your [Hospitable](https://hospitable.com) listings that you design in your browser: a page for each property, with photos, reviews, an availability calendar and more. When you edit a listing in Hospitable, your website follows by itself. You don't write code or rent a server, and Cloudflare's free plan covers the cost.

This project is the part that runs your website: a small program in your own Cloudflare account. You design the site in the [builder](https://hospitable-page-builder.adhityoagam.com/), and when you click Publish, the builder sends it here.

## Is it safe?

Your website needs two keys. The setup keeps both, and everything private, in your hands.

- Your Hospitable token lets your website read your listings. You create it in Hospitable and paste it in one place only: Cloudflare's own website, at `dash.cloudflare.com`. The Deploy to Cloudflare button takes you there, and later you can change the token there too. The builder has no field for it.
- Cloudflare keeps the token in a small program in your own Cloudflare account, which Cloudflare calls a Worker. It's saved there as a secret, and once it's saved Cloudflare hides it even from you. The builder, your website and your visitors never see it.
- The token only needs Read permission, and your Worker only ever reads. It can't change a listing, touch a reservation or send a message.
- The publish key lets the builder put a new version of your site on your Worker. The builder makes it for you, and you paste it into Cloudflare once, as `SITE_KEY`. It can only change your site's pages. It can't read or change anything in Hospitable, and it can't change your Worker's code or settings.
- If the publish key ever leaks, make a new one in the builder, replace `SITE_KEY` in Cloudflare with it (see [Settings](#settings)) and paste the new key in the builder. The old key stops working as soon as Cloudflare has saved the new one.
- Private details are removed before anything is saved: door codes, Wi-Fi passwords, your address, guests' last names and more. [Privacy](#privacy) has the full list.
- Your token and your listing data stay in accounts you own. Your Worker runs in your Cloudflare account, and its code is copied into your GitHub account. The people who make this project never receive your token. The builder is a separate website: it never asks for your token, it reads what your Worker already shows the public, and it uses the publish key to send your site to your Worker.
- Your pages are drawn in your visitors' browsers by page code that comes from the builder's website. That's how new and improved blocks reach your site without you updating anything (see [How your blocks stay up to date](#how-your-blocks-stay-up-to-date)). It also means whoever runs the builder's website can change that code. If you'd rather decide when it changes, set `RUNTIME_URL` to a copy you host yourself.
- Your Worker tells browsers to run scripts on your pages from that one address only, so nobody can slip a script into your site through the text of a block.
- The code of your Worker is open. Anyone can read every line of it on GitHub.
- As with any account that holds a key, turn on two-step login for your Cloudflare, GitHub and Hospitable accounts.

> [!TIP]
> Don't take our word for it. Copy the prompt below, paste it into ChatGPT or Claude, and ask for its opinion. Use a version that can browse the web, so it can open the code.

```text
Please check whether this open-source project is safe for me to use.
It has two parts:
- https://github.com/agmadt/hospitable-pages
  the Worker that runs my website
- https://hospitable-page-builder.adhityoagam.com
  the builder website, where I design my site and click Publish

I'm a vacation rental host, not a programmer. Open the Worker's code and
read the actual code, not only the README: everything in src/, plus
wrangler.jsonc, package.json and scripts/. Tell me which files you
opened. If you can't open them, say so instead of guessing.

Then answer in plain language, and say which file and line each answer
comes from:

1. Follow the setup steps in the README. Where exactly do I type my
   Hospitable access token, and where does it go after that? Could it
   ever reach my website, my visitors, the builder website or anyone
   else?
2. Does the code only read from Hospitable, or can it change anything,
   such as listings, reservations, messages or payments?
3. What could someone do with my publish key (SITE_KEY), and what
   couldn't they do? How do I replace it?
4. Which information about my properties becomes public? Is anything
   private included, such as door codes, Wi-Fi passwords, my street
   address or guest details?
5. My pages load code from the builder website. What can that code do
   on my site, who can change it, and how could I stop it changing?
   Does my Worker track visitors or set cookies?
6. Which outside services are involved, and what does each one receive?
7. Could any of this cost me money?

End with a short verdict: would you install it, and what should I watch
out for?
```

## What you need

- A Hospitable plan with API access (the Host plan or higher).
- A free Cloudflare account and a free GitHub account. You can sign up for both with Google.
- For an address of your own, such as `www.yourvilla.com`, a domain managed in Cloudflare. Until then your site has a free `workers.dev` address. See [Your own domain](#your-own-domain).

## How fresh the data is

Your Worker copies your listings from Hospitable once an hour, and every page a visitor opens is built from that copy. So when you change something in Hospitable, such as a price, a photo or a booked night, your site shows it within about an hour. Bookings themselves happen in Hospitable, which always has the current calendar.

When you publish from the builder, the new version of your site is live straight away. Visitors far from you may see the previous version for up to a minute, while Cloudflare passes the change around the world. Browsers don't keep old copies of your pages: they ask your Worker again on every visit.

## What it costs

For most hosts, nothing.

Cloudflare's free plan allows 100,000 requests a day. Every page a visitor opens is one request. The page code comes from the builder's website and the photos from Hospitable's servers, so they don't count. The free plan also allows 100,000 reads from storage a day: a page view needs one, plus about 5 for each property on the page when your Worker hasn't read the same data in the last minute. That's room for tens of thousands of page views a day. Every Cloudflare account has its own allowance.

Publishing uses about 4 of the free plan's 1,000 storage writes a day, so you can publish a few hundred times a day.

If you ever go over, you aren't charged. Visitors see a Cloudflare error page until the allowance resets at midnight UTC.

For more traffic, Cloudflare's Workers Paid plan costs $5 a month and includes 10 million requests a month. It's also the plan to pick if you have about 40 properties or more.

## Requirements

A few things in Hospitable decide what your site can show:

- Your properties are listed in Hospitable. Unlisted properties are left out.
- Each property has a public name in Hospitable. Your internal property names are never shown, so a property without a public name appears as "Untitled listing".
- Your photos are turned on for the Direct channel (in Hospitable, Property → Details). If they aren't, a gallery only shows the cover photo.
- Knowledge Hub topics only appear if you name them in `PUBLIC_GUIDE_TOPICS` (see [Settings](#settings)), because those topics often contain door codes.
- On the free plan, up to about 10 properties refresh every hour. With more, they take turns, and each one still refreshes several times a day. From about 40 properties, use the Workers Paid plan and set `SUBREQUEST_BUDGET` to `900`.
- Your visitors can open `workers.dev` addresses. Some internet providers block them. An address on [your own domain](#your-own-domain) avoids this.

## Set it up

The easiest way is to follow the [builder](https://hospitable-page-builder.adhityoagam.com/). It takes you through these same steps one at a time. You can design your site there before anything else: it shows sample listings until you connect.

1. In Hospitable, go to Apps → API access → Access tokens. Add a token with Read permission and copy it. A token lasts one year.
2. In the builder, open the Publish dialog and copy your publish key.
3. Click [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/agmadt/hospitable-pages) here or in the builder. It takes you to Cloudflare's own website, at `dash.cloudflare.com`. Sign in to Cloudflare and GitHub there. Paste your Hospitable token into the field named `HOSPITABLE_PAT` and your publish key into `SITE_KEY`, leave `BUILDER_URL` as it is, and click Deploy. Cloudflare sets up your Worker, its storage and the hourly refresh.
4. When Cloudflare is done, click your Worker's address. It looks like `https://hospitable-pages.<your-name>.workers.dev`, and you'll find it on the success page and in your Cloudflare dashboard. It takes you back to the builder, connected to your Worker.
5. Click Publish. Your site is now live at your Worker's address.

Each time you publish again, the new version replaces the old one at once. Your Worker keeps your last 10 versions, so you can go back to an earlier one. The builder can also save a preview: it gets a private address that search engines skip, and your live site stays as it is until you publish.

## How your blocks stay up to date

Your Worker doesn't draw your pages itself. It sends each visitor your site's content and the listing data its blocks need, and page code from the builder's website draws the blocks in the visitor's browser, the same way the builder's preview does. So when a block is fixed or a new one is added, every site has it straight away, without anyone updating their Worker.

Your published site names the version of the page code it was made with, such as `v1`, so a later version that works differently doesn't change a site that was published before it.

Search engines and link previews don't need the page code. Your Worker writes each page's title, description and preview photo (the first photo of the first property on the page) into the page itself, with a plain copy of its text and links. It also serves `/sitemap.xml` and `/robots.txt`.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| Right after your first deploy, your Worker's address shows a security error, such as `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | On a new Cloudflare account, Cloudflare needs time to prepare the security certificate for your `workers.dev` address. This can take more than half an hour. Wait, then open the address again. |
| Your Worker's address doesn't open at all, for you or for some visitors | Your internet provider may block `workers.dev` addresses. Give your Worker [your own domain](#your-own-domain). |
| The builder says your Worker has no publish key (`no_site_key`) | `SITE_KEY` wasn't saved. Add it as a secret (see [Settings](#settings)) and paste the key from the builder's Publish dialog. |
| The builder says your publish key is too short (`weak_site_key`) | The `SITE_KEY` in Cloudflare is shorter than 24 characters, probably cut off while pasting. Replace it with the whole key from the builder. |
| The builder says your publish key is wrong (`401`) | The key in Cloudflare and the key in the builder don't match, for example after you made a new key or switched browsers. Copy the key from the builder's Publish dialog and replace `SITE_KEY` in Cloudflare with it. Cloudflare hides secrets, so you can't copy the key the other way round. |
| The builder says your site was published from another browser (`409`) | Your site was published from another tab, browser or computer since this one last did. Click Publish anyway to replace it with what this builder has. To keep those changes instead, open the Publish dialog, connect again and click Load it into the builder instead. |
| The builder says your site is too large (`413`) | A site can be up to 512 KB. Remove some pages or blocks, or shorten long texts. |
| The builder refuses to publish and names a page or block | Fix what the message says. A page address can't be one your Worker uses itself (`api`, `assets`, `runtime`), and no text may start with `javascript:`, `data:` or `vbscript:`. |
| Blocks that show your listings are empty | Your Worker can't read from Hospitable. Tokens expire after a year: create a new one in Hospitable and replace `HOSPITABLE_PAT` (see [Settings](#settings)). |
| A gallery only shows the cover photo | Turn your photos on for the Direct channel in Hospitable, under Property → Details. |
| Visitors see a Cloudflare error page with the code 1027 | The day's free allowance is used up. It comes back at midnight UTC. |

## Privacy

Anyone who knows your Worker's address can read what it hands out, just as anyone can read your website. So your Worker only stores and hands out what is meant for guests. It never stores or shares:

- your street address, postcode or map coordinates
- Wi-Fi name and password, guest access and check-in instructions, the house manual and "other details"
- iCal import and export links, and calendar notes
- private review feedback, detailed review comments and guests' last names
- your email, billing address and tax details, listing emails, and internal property names and tags
- anything from reservations, guests, messages, transactions or payouts

Your Worker never asks Hospitable for reservations, messages, transactions or payouts. Reviews do arrive with some guest details, such as last names, and your Worker throws those away before saving anything.

Knowledge Hub topics often hold door codes, so your Worker shares none of them until you name the safe ones in `PUBLIC_GUIDE_TOPICS`.

What does become public, so check it once:

- All your listed properties, not only the ones on your site. Open `https://<your-worker>/api/properties` in your browser to see the list your Worker shares.
- Your own texts, word for word. If a description, a house rule or a photo caption mentions a door code or your street address, that becomes public too. The same goes for anything you type into a block.
- Your name (or your company's name, if your Hospitable account is a business) and your profile photo.
- Your earlier versions and previews. They live at addresses with a long random part that isn't linked anywhere, and search engines are told to skip them, but anyone who has such an address can open it until 10 newer versions replace it. If you published something private by mistake, publish a corrected version, and replace your Hospitable texts if the mistake is there.

For your visitors:

- Your Worker sets no cookies and doesn't track anyone.
- To show a page, a visitor's browser connects to your Worker (for the page and its listing data), to the builder's website (for the page code and its styles), to the servers where Hospitable keeps your photos, and to any other service a block uses, such as a map or a video.

## Settings

Change these in Cloudflare under Workers & Pages → hospitable-pages → Settings → Variables and Secrets. On the deploy page you fill in `HOSPITABLE_PAT` and `SITE_KEY` and leave `BUILDER_URL` as it is; add the others here whenever you need them. They stay in place when your Worker is updated.

| Name | What it does | If you leave it out |
| --- | --- | --- |
| `HOSPITABLE_PAT` | Your Hospitable token, with Read permission. It's a secret, so Cloudflare hides its value. Type `dummy` instead to try everything with sample data. | Required |
| `SITE_KEY` | The publish key from the builder, at least 24 characters. It's a secret. It can only change your site's pages. To replace it, make a new key in the builder and paste it here. | The builder can't publish |
| `PUBLIC_GUIDE_TOPICS` | The Knowledge Hub topics your site may show, by name and separated by commas, for example `Local attractions, Where to eat`. | No topics are shown |
| `CACHE_MINUTES` | How long a visitor's browser keeps listing data that blocks fetch from your Worker's `/api/` addresses, from `0` (not at all) to `1440` (a day). Your pages themselves are never kept. | `240` (4 hours) |
| `SUBREQUEST_BUDGET` | How many calls to Hospitable one hourly refresh may make. Raise it to `900` on the Workers Paid plan. | `45` |
| `BUILDER_URL` | Where your Worker's home page sends you before your first publish, the one website that may publish from a browser, and where the page code comes from. If you run your own copy of the builder, change it in `wrangler.jsonc` in your copy on GitHub rather than here, so updates keep it. | This project's builder |
| `RUNTIME_URL` | Where your pages load their page code from instead, as an `https://` address of a folder that holds `v1/site.js` and `v1/site.css`. | The `runtime/` folder of the builder's website |

The hourly refresh isn't a setting here: its schedule lives in the `wrangler.jsonc` file. If you change it in the Cloudflare dashboard instead, the next update from GitHub puts it back to hourly.

With `HOSPITABLE_PAT` set to `dummy`, your Worker runs on sample data and never contacts Hospitable. You can publish and look at your site the same way.

### Your own domain

Your site can also answer on an address of your own, such as `www.yourvilla.com`. The domain has to be managed in the same Cloudflare account as your Worker.

1. In Cloudflare, open Workers & Pages → hospitable-pages → Settings → Domains & Routes, click Add and choose Custom domain.
2. Enter the address and add it. Cloudflare creates the DNS record and the security certificate.
3. In the builder, enter the new address as your Worker's address, so it publishes there and shows you the right links.
4. Search engines should find your site at one address only. Once the new address works, turn off the `workers.dev` address in the same Domains & Routes list.

### Keeping your Worker up to date

Most improvements are in the page code, which your pages load from the builder's website, so they reach your site without you doing anything.

Improvements to your Worker take one click on GitHub, once you've added an update button. The Deploy button made a copy of this project in your GitHub account, and Cloudflare updates your Worker whenever that copy changes.

To add the update button, once:

1. On GitHub, open your copy. It has the same name as your Worker.
2. Click Add file → Create new file and name the file `.github/workflows/update.yml`.
3. Open [docs/update-workflow.yml](docs/update-workflow.yml) in this project, click its Copy raw file button, paste the text into your new file and click Commit changes.

To update, whenever you like: open the Actions tab of your copy, choose Update from hospitable-pages and click Run workflow. It copies in the newest release and keeps your Worker's name, its storage (your listing data and your published site) and the values you entered when deploying. Cloudflare then updates your Worker, its address stays the same, and the settings you added in the Cloudflare dashboard stay too. It only runs when you click it.

---

## For developers

```sh
npm install
cp .dev.vars.example .dev.vars   # HOSPITABLE_PAT=dummy; add a SITE_KEY of 24+ characters
npm run dev                      # http://127.0.0.1:8787
npm test                         # the Worker in dummy and live mode, with a fake Hospitable
```

| Path | What it is |
| --- | --- |
| `src/index.js` | Routes requests, and the hourly cron |
| `src/pages.js` | The public site: pages, previews, `sitemap.xml`, `robots.txt`, and the listing data each page inlines |
| `src/render.js` | The HTML of a page: head tags, `#site-data` JSON, the plain-HTML fallback, the runtime address |
| `src/publish.js` | `/api/site`: the publish key, CORS for the builder, publish, versions, rollback |
| `src/validate.js` | Generic checks on a published site; block types are unknown to the Worker |
| `src/site.js` | Versions in the `SITE` namespace |
| `src/api.js` | Public listing data under `/api/properties` and `/api/host`, as in hospitable-widgets |
| `src/listings.js`, `src/hospitable.js`, `src/normalize.js`, `src/amenities.js`, `src/store.js`, `src/dummy.js` | Listing data: reading, the hourly refresh, the read-only Hospitable client, the privacy allowlist and dummy mode, shared with hospitable-widgets |

| Method and path | Key | What it does |
| --- | --- | --- |
| `GET /`, `GET /<slug>` | | A page of the live site. Before the first publish, `/` redirects to `BUILDER_URL?worker=<origin>`. |
| `GET /_preview/<version>/<slug>` | | Any stored version, with `noindex` |
| `GET /api/site` | yes | The live site, its version, the mode and the Worker's version |
| `PUT /api/site` | yes | Publishes. `?preview=1` stores without going live; `If-Match: <version>` refuses with `409` if the live version differs. |
| `GET /api/site/versions` | yes | The last 10 versions, newest first |
| `POST /api/site/rollback` | yes | `{ "version": "<id>" }` makes that version live |

[MIT license](LICENSE). Not affiliated with or endorsed by Hospitable.
