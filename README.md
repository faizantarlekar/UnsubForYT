<p align="center">
  <img src="icons/icon128.png" alt="Mass Unsubscribe for YouTube logo" width="96">
</p>

<h1 align="center">Mass Unsubscribe for YouTube</h1>

<p align="center">
  A small Chrome extension that lists all your YouTube subscriptions in a popup,
  lets you tick the ones you want gone, and unsubscribes from them in one go.
</p>

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by YouTube or Google.

## Features

- Lists every channel you're subscribed to, with avatar and subscriber info
- **Select all / Deselect all** checkbox (works on whatever the search filter is showing)
- Search to narrow the list, then bulk-select the matches
- Progress bar, **Stop** button, and a per-channel result (unsubscribed / failed)
- Safe by default: two-step confirmation before anything happens, gentle pacing between requests, and an automatic stop after 3 failures in a row
- Close the popup mid-run; it keeps going as long as the YouTube tab stays open
- No accounts, no servers, no tracking. Everything runs in your browser

## Install (from source)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser, version 111+).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu so the icon is easy to reach.

## Usage

1. Open [youtube.com](https://www.youtube.com) and make sure you're signed in.
   If the tab was already open when you installed the extension, reload it once.
2. Click the extension icon. Your subscriptions load automatically.
3. Tick the channels you want to remove, or use **Select all**.
4. Click **Unsubscribe**, then click it again within 4 seconds to confirm.
5. Watch the progress bar. Finished channels are struck through; failures stay ticked so you can retry.

> There is no bulk undo. Try it with two or three channels first and check on YouTube that they're gone.

## How it works

YouTube's page is a single-page app, and its layout changes often, so this extension does not click buttons on the page. Instead:

- `inject.js` runs inside the YouTube page (`"world": "MAIN"`), reads YouTube's own session config, and calls YouTube's internal `youtubei/v1` endpoints with your logged-in session:
  - `browse` (`FEchannels`) with pagination to list subscriptions
  - `subscription/unsubscribe` to remove a channel
- `bridge.js` runs in the extension's isolated world, relays messages between the popup and `inject.js`, and remembers progress so the popup can be closed and reopened.
- `popup.html` / `popup.js` / `popup.css` render the channel list and controls.

### Project structure

```
.
├── manifest.json     # Manifest V3 config
├── inject.js         # Page-context script: fetches list, unsubscribes
├── bridge.js         # Content-script bridge + progress state
├── popup.html        # Popup UI
├── popup.css
├── popup.js
└── icons/            # Extension icons (PNG) and SVG master
```

## Privacy

- The extension only runs on `https://www.youtube.com/*`.
- It does not collect, store, or transmit any data. Your subscription list stays in the page and the popup.
- Requests go only to YouTube itself, using your existing session. No credentials are read other than what YouTube's own page already sends with its requests.

## Limitations and troubleshooting

- It relies on **undocumented YouTube endpoints**, which can change without notice. If the list comes back empty or unsubscribes start failing, YouTube probably changed its data format. Open an issue with the error shown in the popup.
- **"The extension isn't active in this YouTube tab"**: reload the YouTube tab (needed once after installing or updating).
- **HTTP 401/403 errors**: make sure you're signed in to the right account, then reload YouTube.
- Very large batches may be rate-limited by YouTube. Do them in chunks if you see repeated failures.
- Multiple Google accounts and brand accounts are supported on a best-effort basis (it uses the account active in the YouTube tab).

## Development

There is no build step. Edit the files, then press the reload icon on the extension's card at `chrome://extensions` and reload your YouTube tab.

The logo is in `icons/icon.svg`. PNGs can be regenerated with, for example:

```bash
for s in 16 32 48 128; do rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon$s.png; done
```

## Disclaimer

Use at your own risk. Automated actions on your account may be subject to YouTube's Terms of Service, and the authors are not responsible for any consequences of using this tool.
