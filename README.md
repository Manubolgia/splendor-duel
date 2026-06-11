# Splendor Duel — multiplayer PWA

Two-player Splendor Duel playable in real time on the web. Static frontend
(GitHub Pages) + Cloudflare Worker with a Durable Object holding the
authoritative game state, relayed over WebSockets.

## How it works

- **Player 1** opens the app, taps **Create Game**, gets a 4-letter code (e.g. `KXMB`).
- **Player 2** opens the app, enters the code, joins instantly.
- Every move is validated by the Durable Object and broadcast to both players.
- Reconnects are seamless: each player gets a seat token stored in
  `localStorage`, so refreshing or losing signal does not lose your seat.
- You can also share a direct link: `https://<your-pages-url>/#KXMB`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file PWA — full UI + client logic |
| `manifest.json` | PWA manifest (full-screen, Add to Home Screen) |
| `sw.js` | Service worker — offline shell + asset caching |
| `icon-192.png` / `icon-512.png` | App icons |
| `worker.js` | Cloudflare Worker + `GameRoom` Durable Object (rules engine) |
| `wrangler.toml` | Worker config with the Durable Object binding |

## Deploy

### 1. Worker (Cloudflare)

```sh
npm install -g wrangler   # if you don't have it
wrangler login
wrangler deploy
```

Note the URL it prints, e.g. `https://splendor-duel.<your-subdomain>.workers.dev`.

> Durable Objects require the Workers Paid plan **or** the free tier with
> SQLite-backed DOs. If `wrangler deploy` complains on the free plan, change
> the migration in `wrangler.toml` from `new_classes` to
> `new_sqlite_classes = ["GameRoom"]`.

### 2. Point the frontend at your Worker

In `index.html`, set the constant near the top of the `<script>`:

```js
const WORKER_URL = 'https://splendor-duel.<your-subdomain>.workers.dev';
```

### 3. Frontend (GitHub Pages)

```sh
git checkout -b gh-pages
git add index.html manifest.json sw.js icon-192.png icon-512.png
git commit -m "Deploy frontend"
git push origin gh-pages
```

Then in the GitHub repo: **Settings → Pages → Source: `gh-pages` branch, `/ (root)`**.
The app will be at `https://<user>.github.io/<repo>/`.

(GitHub Pages serves over HTTPS, which is required for service workers and
for `wss://` WebSocket connections — don't open `index.html` from `file://`.)

### 4. Install on iPhone

Open the Pages URL in **Safari** → Share → **Add to Home Screen**. The app
launches full-screen with no browser chrome, respects the notch/home-bar
safe areas, and caches its shell for offline launch (a connection is still
needed to actually play, of course).

## Rules implemented

- 25 tokens (4× each gem color, 2 pearls, 3 golds), spiral board refill from the bag.
- Take up to 3 adjacent tokens in a straight line (taking 3 of a color or
  2 pearls gives your opponent a privilege).
- Reserve a card (face-up or blind from a deck) + take a gold; max 3 reserved.
- Buy cards with automatic gold-as-wildcard payment; spent tokens return to the bag.
- All card powers: **play again**, **steal a token**, **take a matching gem**,
  **gain a privilege**, and **wild-color cards** that count as a color you own.
- Crowns: at 3 and at 6 crowns you choose a royal card (with their own powers).
- Privileges (3 scrolls): spend before your action to grab a gem; replenishing
  the board hands one to your opponent. The second player starts with one.
- 10-token hand limit with forced discard.
- All 3 win conditions: **20 prestige points**, **10 crowns**, or
  **10 points in a single color**.

Note: the three card decks (30 / 24 / 13 cards) follow the official structure,
tiers, powers, and distribution, with costs/values that closely approximate
(but are not a 1:1 copy of) the published card list.

## Development

- `node .engine-test.mjs` — fuzz test: 300 full random games against the rules
  engine, checking token/privilege conservation, termination, and that the
  per-seat state sanitization never leaks hidden information.
- `node .ws-test.mjs` — integration test: two WebSocket clients create/join a
  room on a local `wrangler dev` server (port 8787) and play random legal
  moves until someone wins.
