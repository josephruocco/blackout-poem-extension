# Newspoem

A Chrome extension that turns news articles into blackout poems. Words are redacted in real time, leaving behind a hidden poem on the page.

## How it works

On supported news sites, Newspoem scans article paragraphs and blacks out most of the text, revealing a short poem composed of the remaining words. Hover a redacted block to peek at what's underneath; click the on-page chip (or the popup button) to reroll.

## Features

- **Smart mode** — selects coherent, poetic phrases
- **Random mode** — more chaotic word selection
- **Poem length** — adjustable from 8 to 35 words
- **Hover to peek** — temporarily reveal hidden words
- **Show/hide all** — toggle the full text back on
- **Reroll** — generate a new poem from the same article

## Supported sites

NYT, WSJ, Washington Post, The Guardian, BBC, CNN, Fox News, Reuters, AP News, Bloomberg, FT, The Economist, The New Yorker, The Atlantic, NBC News, CBS News, ABC News.

## Install (development)

1. Clone this repo
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the repo folder
4. Open any supported news article

## Demo

A static demo page lives at [`demo/index.html`](demo/index.html).

## Privacy

Newspoem runs entirely in your browser. It doesn't collect, transmit, or store any browsing data. See [`privacy.html`](privacy.html) for details.

## License

© Joseph Ruocco. All rights reserved.
