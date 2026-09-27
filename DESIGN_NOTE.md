# Design Note — Scraping Reliability

## What the store's difficulty actually is
The brief says the store is "deliberately awkward to scrape." Confirmed
live, it's not generic bot-detection — it's a specific, layered client-side
challenge on the price-check action:

1. **Client-rendered SPA.** No content exists in server-side HTML; every
   page is an empty `<div id="root">` filled in by JS. Requires a real
   browser (Playwright), not HTTP+parsing.
2. **Hover-gated load, not click-gated.** The price starts in a "locked"
   state; loading it requires a real hover — confirmed that a single-jump
   `locator.hover()` (an instant mouse teleport) never triggers it at all
   (30/30 attempts, zero network calls). Fixed by walking the mouse to the
   target over ~15-25 incremental `mouse.move()` steps with small per-step
   delays, mimicking an actual movement path.
3. **A real proof-of-work + attestation challenge on the confirming
   request.** `GET /api/v2/handshake` returns a salt, a difficulty level,
   and a WASM binary. The client must run the WASM, and `POST
   /api/v2/handshake` sends back a nonce/derived-hash pair from that
   computation, *plus* a full attestation blob: canvas fingerprint, WebGL
   fingerprint, hardware concurrency, screen size, animation-frame timing
   samples, and the actual mouse-interaction record (hover start time,
   dwell duration, the full array of intermediate mouse coordinates with
   timestamps, click time, and the event's `isTrusted` flag).
4. **Confirmed and fixed one real bug in our own retry logic**: naive
   retrying re-sent the *same* interaction record on every retry (identical
   `hoverAt`/`moves[]` array across 5 straight attempts, with only the click
   timestamp advancing) — dwell time on the last of those reached 40+
   seconds, an obvious automation signature. Fixed: every retry now moves
   the mouse away first, then re-walks a fresh hover path before clicking,
   so each attempt carries its own short, plausible interaction record.
5. **Even after that fix, the POST still returns 401 "unauthorized" on
   every attempt tested**, across multiple items/options. This is
   consistent with the WASM proof-of-work output and/or the fingerprint
   fields needing to match something server-side that a scripted browser
   genuinely cannot produce (a real GPU/canvas fingerprint, or a
   server-held computation this WASM module is deliberately shaped to only
   validate from a specific reference environment). Extensive testing
   (dozens of attempts, varied items/options, incognito/fresh-session
   testing, manual real-mouse testing in a real Chrome window) all produced
   the same result. Treated as a confirmed, currently-unbeaten gate rather
   than a bug to keep chasing indefinitely.

## Failure handling (the part that matters most given #5)
Every attempt is wrapped; nothing fabricated is ever stored. When the live
price gate can't be passed after `INNER_RETRIES` in-page attempts, the
scrape is logged **honestly as `outcome: 'failed'`, with `price`/`stock`
left `null`** — exactly per the assignment's own spec ("Failed attempts
must be included, with price and stock left empty"). The page's own
struck-through "listed" price (visible even before the live gate opens) is
still captured and surfaced in the `error_message` field as
`listedPriceHint`, purely for context in the scrape log UI — deliberately
**not** written to the `price`/`stock` columns or the CSV export, because
doing so would freeze the price-history chart on one static number forever
and misrepresent it as a live reading. That's the specific kind of
misleading signal the brief warns against, so it was corrected out (an
earlier draft in this session used a non-spec outcome value for exactly
this and was caught by the DB's own `check` constraint on `outcome`).

Beyond the price gate specifically:
- A real 429 (upstream rate limit) is also handled: the response listener
  reads the `Retry-After` header (or backs off 15s/30s/45s...capped at 2min
  if absent) before the next in-page attempt, rather than hammering it.
- A blocked/challenge page (title/body text matching known block markers)
  is treated as a failure for that attempt and retried with a brand-new
  browser context.
- Decoy DOM nodes: an earlier pass found hidden/off-screen decoy price
  nodes alongside the real one. `isGenuinelyVisible()` filters candidates
  by computed `display`/`visibility`/`opacity`/bounding-box before trusting
  their text.

## Search: real fix, not just a workaround
The store has no filtered-search endpoint. The original approach opened
every matching product card in a headless browser one at a time (click →
read URL → go back) — correct but slow. Confirmed via DevTools that the
home page's own product grid is fed by a plain, unauthenticated JSON
endpoint (`GET /api/v2/listings?page=N&limit=20`, 48 pages × 20 items).
Rewritten to fetch that directly and filter client-side — no browser
needed for search at all. Fetching all 48 pages at once overwhelmed the
demo server (one came back as an HTML error page instead of JSON, crashing
the parse) — fixed by batching 6 pages at a time with a small gap between
batches, and treating a non-JSON response as a skippable failure rather
than throwing.

## Trade-offs
- Playwright over lightweight HTTP fetch for scraping itself: the SPA
  requires JS execution; there's no server-rendered content to parse.
- `INNER_RETRIES` set high (20) for the in-page hover/click loop since,
  before the gate was confirmed deterministic, failures looked
  probabilistic and worth retrying; `MAX_RETRIES` (outer, fresh browser
  context) kept lower (5) since a new context doesn't change the outcome
  once the gate is understood to be deterministic — confirmed via an
  Incognito test (zero prior cookies, identical 401).
- Selectors centralised in one `SELECTORS` object so DOM changes don't
  require touching retry/backoff logic.

## Where AI assistance was used, and what it got wrong first
Used Claude throughout — for scaffolding, and for the live investigation
(reading DevTools screenshots/network captures, forming and testing
hypotheses). Things it got wrong on the way, each caught by testing live
against the actual store rather than by reasoning alone:
- First assumed this was generic bot-detection and reached for
  stealth-plugin/UA-rotation/timing-jitter countermeasures — none of that
  was the actual blocker.
- First read of "offer-failed" assumed a stale/broken session and
  recommended relaunching the browser context on every handshake 401 —
  disproved by an Incognito test (fresh cookies, identical result).
- Missed for a long time that `locator.hover()` was a no-op for this site
  (a single mouse teleport, not a movement path) — only found via a
  diagnostic script that logged actual network activity per attempt and
  showed zero requests firing across 30 tries.
- Once real requests were flowing, missed that the retry loop was resending
  an identical, stale interaction fingerprint on every attempt — only
  visible once the diagnostic script was extended to print the actual
  request/response bodies, not just status codes.
- An intermediate version stored a non-spec `outcome` value
  (`stale_fallback`) to preserve a "some price is better than none"
  fallback — this both violated the DB's check constraint and, more
  importantly, would have silently misrepresented a stale price as fresh
  data in the exported history. Caught and corrected before submission.
