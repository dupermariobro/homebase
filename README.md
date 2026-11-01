# Homebase

A self-hosted family hub for a wall tablet: calendar, chores and rewards, meals, and shopping lists.
It runs on any always-on computer at home (a Mac mini, a Raspberry Pi 4/5, a NAS, an old laptop)
and every screen in the house just opens it in a browser. No accounts, no subscription, no cloud:
your family's data stays in one SQLite file on your machine.

**Features:** Today board · color-coded calendars (+ a shared Family calendar) · Homebase-only events ·
chores with points, weekly rotation, parent approval, streaks, and optional allowance · rewards ·
one-off to-dos · meal plan + recipe box (import from recipe sites) · shopping lists · sticky notes ·
countdowns + birthdays · photo screensaver · phone reminders via ntfy · optional ✨ AI quick-add
(type or snap a photo of a school flyer → events, chores, groceries) · an ambient TV view at `/tv/ambient`.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone <this repo> homebase && cd homebase
npm run setup          # installs server + client dependencies
npm run build          # builds the tablet UI
cp .env.example .env   # optional: AI key, ntfy token, ports
npm start              # http://localhost:4830
```

Open `http://<this-computer's-LAN-IP>:4830` on the tablet. The first run seeds a **sample family**
(Alex, Sam, Jordan, Riley, Casey) with starter chores and rewards so the board isn't empty;
rename, recolor or delete them in **Settings**.

To keep it running in the background, see `scripts/homebase.plist.example` (macOS launchd) or
`scripts/homebase.service.example` (Linux systemd).

## First-time setup (in the app → Settings)

1. **Set a parent PIN.** Until you do, anyone on your network can change settings (see Security).
2. **Weather:** search your city.
3. **Calendars:** for each person, in Google Calendar on the web → ⚙ Settings → pick the calendar →
   *Integrate calendar* → copy **Secret address in iCal format** → paste it into that person's profile.
   Any iCal (.ics) URL works (iCloud public calendars, Outlook, Fastmail…). Events refresh every 5 minutes.
4. **Family calendar:** Settings → Family (calendar only) → paste the shared calendar's iCal address.
5. **AI quick-add (optional):** put an OpenAI API key in `.env` as `OPENAI_API_KEY`, then restart.
   Uses `gpt-5-mini` by default (a fraction of a cent per quick-add); set `OPENAI_MODEL` to change it.
6. **Reminders (optional):** Settings → Reminders → your ntfy server; then each person's profile → ntfy topic → Test.
   See `ntfy/server.example.yml` to run a private ntfy server.
7. **Chores and rewards:** edit the starter set under Chores → *Manage chores*.

## Set up the wall tablet

**iPad:** open the URL in Safari → Share → *Add to Home Screen* → launch from the icon (full-screen).
Settings → Accessibility → *Guided Access* on, then triple-click the side button inside Homebase to lock
the iPad to it. Settings → Display → Auto-Lock → *Never*.

**Android / Fire tablet:** install *Fully Kiosk Browser*, set the start URL, enable *Keep screen on*
and *Kiosk mode*. Optionally schedule the screen off overnight (Homebase also shows a dim night clock).

## Away from home (optional)

Homebase starts a second, **loopback-only** listener (`127.0.0.1:4831`) meant to be published to the
internet by a tunnel you control, e.g. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel):

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:4831
```

Then put that public address in `.env` as `HOMEBASE_PUBLIC_URL` (e.g. `https://your-machine.your-tailnet.ts.net:8443`)
and restart. Unlinked visitors only see a "not linked" page. Linking phones requires a parent PIN. To link a phone: tablet → Settings → **Away from home**
→ **Link a phone** (PIN) → scan the QR code (one-time, expires in 15 minutes) → on the phone tap
**Link phone**, then Share → **Add to Home Screen**. **Unlink** revokes access immediately.
Set `HOMEBASE_REMOTE_PORT=0` to disable the listener entirely.

## Security

Homebase is built for a trusted home network. Read this before exposing anything:

- **Trust model.** Anyone on your LAN, and every linked phone, can do everything that isn't behind
  the parent PIN: check off chores, edit lists, meals, notes and events, upload photos, and run AI
  quick-add (which spends your OpenAI credit). Don't port-forward port 4830; use the away-from-home
  entrance above instead.
- **Set a parent PIN.** It guards Settings, calendars, chores and rewards, redeeming rewards,
  un-checking chores, and linking phones. Wrong guesses are rate-limited per device and in total.
  The tablet forgets the PIN after 5 minutes.
- **Linked phones** stay linked (up to 400 days) until you press **Unlink** in Settings.
  Set `HOMEBASE_REMOTE_PORT=0` if you never want the away-from-home entrance.
- **Browser protections.** The LAN listener only answers to IP addresses, `localhost`, and
  `.local` / `.lan` / `.home.arpa` / `.ts.net` names (add others in `HOMEBASE_ALLOWED_HOSTS`), which
  blocks DNS-rebinding pages. API writes must carry an `X-Homebase` header, which other websites can't
  send, so a page a family member visits can't act on Homebase. Scripts calling the API should send
  `X-Homebase: 1`.
- **Outbound fetches.** Recipe import only fetches public web addresses: private and LAN addresses,
  LAN-only names and redirects into your network are refused, and pages are size-capped.
  Calendar (iCal) addresses can only be set with the PIN.
- **Secrets stay server-side.** The OpenAI key and ntfy token live only in `.env`. The ntfy token is
  only ever sent to `HOMEBASE_NTFY_URL`. Calendar addresses and ntfy topics are never returned to the
  tablet. Don't put credentials inside the ntfy server address in Settings, because it is shown there.
- **Photos.** Uploads must be real JPEG, PNG, WebP or HEIC files. On macOS, large and HEIC photos are
  converted with the built-in `sips`. On Linux, upload JPEG/PNG/WebP under 4 MB (or add your own converter).
- **Back up `data/`** (the SQLite database and photos). It holds your family's calendar links,
  chores and photos. It's gitignored; never commit it.

## Development

```bash
npm run dev     # server with --watch + Vite client on :5183 (proxies /api to the server)
npm test        # server tests (node:test)
npm run build   # rebuild the client after UI changes
```

- Data: `data/family.db` (SQLite). Back it up by copying the file (or the whole `data/` folder).
- Tablets reload themselves nightly at 3 am to pick up new builds.

## Credits

Fonts: IBM Plex and Shippori Mincho, both under the SIL Open Font License 1.1 (see `server/fonts/`).

## License

MIT. See [LICENSE](LICENSE).
