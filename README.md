# VibeHub (free Cloudflare version)

Runs on Cloudflare's **Workers Free plan + D1 database**. No credit card needed. If you ever
hit the free daily limits, the site just pauses until the next day (midnight UTC) - you are never
billed unless you manually upgrade.

## Deploy (about 10 minutes, one time)

You need a free Cloudflare account (https://dash.cloudflare.com/sign-up) and Node.js (https://nodejs.org, LTS version).
Open a terminal in this folder and run:

1. `npm install`
2. `npx wrangler login`  (opens your browser to log in)
3. `npx wrangler d1 create vibehub-db`
   -> it prints a `database_id`. Paste it into `wrangler.jsonc` replacing `PASTE_YOUR_DATABASE_ID_HERE`.
4. `npx wrangler d1 execute vibehub-db --remote --file=schema.sql`  (creates the tables)
5. `npx wrangler deploy`  (prints your live link, like https://vibehub.YOURNAME.workers.dev)
6. `npx wrangler secret put ADMIN_PASSWORD`  (type a strong password when asked)

Open your link, click **Admin** at the bottom, and log in.

To update the site later, edit the files and run `npx wrangler deploy` again.
Custom domain: Cloudflare dashboard -> Workers -> vibehub -> Settings -> Domains (you pay the domain registrar, hosting stays free).

## How it works
- Anyone can submit a game. It goes to a pending queue, not the site.
- You log in, preview each request (play it or read the code), then Approve or Reject.
- Only you can publish, delete, or close submissions.

## Anti-flood protections
- 3 submissions per hour per IP
- Max 50 requests waiting in the queue
- Max 200 KB per game
- Hidden honeypot field to trap bots
- "Close submissions" button to stop everything instantly
- Admin login limited to 10 tries per 15 minutes
- Games run in a sandboxed iframe with no access to your admin session

## Free limits (as of Oct 2026)
- Website pages/files: free and unlimited
- API (Worker): 100,000 requests/day
- Database: 5 million reads/day, 100,000 writes/day, 5 GB storage
Plenty for a game site. Blocked spam attempts cost only a read, not a write.
