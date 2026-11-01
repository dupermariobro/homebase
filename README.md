# Homebase

A self-hosted family hub for a wall tablet: calendar, chores and rewards, meals, and shopping lists.
It runs on any always-on computer at home (a Mac mini, a Raspberry Pi 4/5, a NAS, an old laptop)
and every screen in the house just opens it in a browser. No accounts, no subscription, no cloud:
your family's data stays in one SQLite file on your machine.

**Features:** Today board · color-coded calendars (+ a shared Family calendar) · Homebase-only events ·
chores with points, weekly rotation, parent approval, streaks, and optional allowance · rewards ·
one-off to-dos · meal plan + recipe box (import from recipe sites) · shopping lists · sticky notes ·
countdowns + birthdays · photo screensaver · phone reminders via ntfy · optional ✨ AI quick-add
(type or snap a photo of a school flyer → events, chores, groceries).

## Getting started

Setup takes about 15 minutes. You need:

- **An always-on computer at home** to run Homebase: a Mac, a Linux box or Raspberry Pi 4/5, or a NAS
  that runs Node. It must stay on and on your home network.
- **Node.js 22.19 or newer** on that computer. Check with `node --version`; install it from
  [nodejs.org](https://nodejs.org) (or `brew install node` on a Mac).
- **Git** (`git --version`; on a Mac, `xcode-select --install` provides it).
- **A tablet** (iPad, Android or Fire) on the same Wi-Fi, for the wall.

### 1. Download and install

On the always-on computer, open a terminal and run:

```bash
git clone https://github.com/dupermariobro/homebase.git
cd homebase
npm run setup
npm run build
```

`npm run setup` installs everything (server and tablet app); `npm run build` builds the tablet app.
On a Raspberry Pi, if setup fails while building `better-sqlite3`, run
`sudo apt install -y build-essential python3` and try again.

### 2. (Optional) Settings file

Everything works without it. To add AI quick-add, phone reminders or away-from-home access later:

```bash
cp .env.example .env
```

Then edit `.env`. Each setting is explained inside the file. Restart Homebase after changing it.

### 3. Start Homebase

```bash
npm start
```

You should see `Homebase listening on http://0.0.0.0:4830`. Leave this terminal open for now
(step 7 makes it run on its own). Open **http://localhost:4830** in a browser on the same computer to check it works.

The first start creates a **sample family** (Alex, Sam, Jordan, Riley, Casey) with starter chores and
rewards, so the board isn't empty. You'll replace them with your own family in step 5.

### 4. Open it on the tablet

Find the computer's address on your network:

- **Mac:** `ipconfig getifaddr en0` (if that prints nothing, try `ipconfig getifaddr en1`)
- **Linux / Raspberry Pi:** `hostname -I` (the first number)

On the tablet, open **http://THAT-ADDRESS:4830**, e.g. `http://192.168.1.50:4830`.

If it doesn't load: make sure the tablet is on the same Wi-Fi, and on a Mac allow `node` when macOS asks
about incoming connections (System Settings → Network → Firewall). Tip: reserve the computer's address in
your router's settings so it never changes.

### 5. Make it yours (in the app → Settings)

Do these in order:

1. **Parent PIN:** set a 4-digit PIN first. Until you do, anyone on your Wi-Fi can change settings.
2. **Household:** rename the sample people to your family (or remove them and add your own), pick
   colors, and mark who earns rewards. *Family* is a shared calendar, not a person.
3. **Calendars:** in each person's profile, paste their calendar's private iCal address. For Google
   Calendar: on a computer, open Google Calendar → ⚙ Settings → click the calendar → *Integrate calendar* →
   copy **Secret address in iCal format**. iCloud, Outlook and other `.ics` addresses work too.
   Put the shared family calendar on *Family*. Events refresh every 5 minutes.
4. **Weather location:** search your city or ZIP code.
5. **Chores and rewards:** Chores tab → *Manage chores* to replace the starter chores and rewards.
6. **Optional extras:** Allowance (cents per point), Reminders (see *Phone reminders* below),
   AI quick-add (see *AI providers* below) and Away from home (see below).

### 6. Set up the wall tablet

**iPad:** open the address in Safari → Share → *Add to Home Screen* → open Homebase from that icon
(it runs full-screen). Then Settings → Accessibility → *Guided Access* → on; open Homebase and
triple-click the side (or home) button to lock the iPad to it. Settings → Display & Brightness →
Auto-Lock → *Never*.

**Android / Fire tablet:** install *Fully Kiosk Browser*, set the start URL to the address, and turn on
*Keep screen on* and *Kiosk mode*. Optionally schedule the screen off overnight (Homebase also dims to a night clock).

### 7. Keep it running

So Homebase starts by itself and survives restarts, stop the terminal from step 3 (Ctrl+C) and install
it as a service:

- **Mac:** copy `scripts/homebase.plist.example` to `~/Library/LaunchAgents/local.homebase.plist`,
  replace `/PATH/TO/homebase` with your folder (run `pwd` inside it), then run
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.homebase.plist`.
- **Linux / Raspberry Pi:** copy `scripts/homebase.service.example` to
  `~/.config/systemd/user/homebase.service`, replace `/PATH/TO/homebase`, then run
  `systemctl --user daemon-reload && systemctl --user enable --now homebase` and
  `loginctl enable-linger "$USER"`.

### Updating

```bash
cd homebase && git pull && npm run setup && npm run build
```

Then restart Homebase (Mac: `launchctl kickstart -k gui/$(id -u)/local.homebase`;
Linux: `systemctl --user restart homebase`). Tablets pick up the new version by their nightly 3 am reload,
or reload the page.

### Troubleshooting

- **"Port 4830 already in use":** Homebase is already running (perhaps as the service), or another app uses
  the port. Set `HOMEBASE_PORT=4840` in `.env` to use a different one.
- **The tablet shows "Unknown host":** you opened Homebase by a name rather than an address. IP addresses,
  `localhost` and `.local` names always work; add other names to `HOMEBASE_ALLOWED_HOSTS` in `.env`.
- **Calendar events don't appear:** make sure you pasted the *secret* iCal address (it contains
  `private-`), then tap ↻ on the Calendar tab.
- **Forgot the parent PIN:** stop Homebase and run
  `sqlite3 data/family.db "DELETE FROM settings WHERE key='pin_hash'"`, then start it and set a new one.

## AI providers

AI quick-add and recipe import work with any service that speaks the OpenAI Chat Completions API.
Set these in `.env` and restart:

| Provider | `OPENAI_BASE_URL` | `OPENAI_API_KEY` | `OPENAI_MODEL` (example) |
|---|---|---|---|
| OpenAI (default) | *(leave unset)* | your key | `gpt-5-mini` (default, a fraction of a cent per quick-add) |
| OpenRouter | `https://openrouter.ai/api/v1` | your key | `openai/gpt-5-mini` |
| Ollama (local, free) | `http://localhost:11434/v1` | *(leave unset)* | `qwen2.5vl:7b` |
| LM Studio (local, free) | `http://localhost:1234/v1` | *(leave unset)* | the model you loaded |

- The model must support **structured (JSON schema) output**. Photo quick-add also needs a model that can
  **read images**. Small local models handle typed quick-adds well; flyers and handwriting need a capable vision model.
- **Privacy:** quick-add sends what you type or photograph, plus your household's names, roles and birthdays (so
  "Riley's dentist Thursday" lands on the right calendar), to the provider you choose. A local model keeps all of
  it in your house.
- A ChatGPT subscription doesn't include API access; use an API key from the provider instead.

## Phone reminders (optional)

Homebase can send each person reminders before their events, a morning summary and an afternoon chore
nudge through [ntfy](https://ntfy.sh). Install the ntfy app on each phone, then:

- **Simplest:** Settings → Reminders → server `https://ntfy.sh`. In each person's profile, set a long random
  ntfy topic (anyone who knows the topic can read it), subscribe to that topic in their ntfy app, and tap **Test**.
- **Private:** run your own ntfy server with `ntfy/server.example.yml`, put its address in
  `HOMEBASE_NTFY_URL` and its publish token in `HOMEBASE_NTFY_TOKEN` (in `.env`), and use that address in Settings.

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
  blocks DNS-rebinding pages. API writes must send JSON (or an image) or an `X-Homebase: 1` header,
  which other websites can't do without permission Homebase never grants, so a page a family member
  visits can't act on Homebase.
- **Outbound fetches.** Recipe import only fetches public web addresses: private and LAN addresses,
  LAN-only names and redirects into your network are refused, and pages are size-capped.
  Calendar (iCal) addresses can only be set with the PIN.
- **Secrets stay server-side.** The AI API key and ntfy token live only in `.env`. The ntfy token is
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

## License

MIT. See [LICENSE](LICENSE).
