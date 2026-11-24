# Dark Pattern Shield (v0.1)

## Load it
1. Open chrome://extensions and turn on Developer mode.
2. Click "Load unpacked" and choose this folder.
3. Open test-page.html (or any shopping / subscription site) and click the shield icon.

## What it detects
| Feature | How |
|---|---|
| Small text | computed font-size vs. page body, only on text with payment/terms keywords |
| Hidden info | display:none text, collapsed <details>, aria-expanded=false panels, near-invisible/low-contrast text |
| Subscriptions | regex rules for renewals, trials, recurring prices, cancellation/refund limits |
| Hidden charges | regex rules for processing/service/handling fees, "plus taxes", etc. |
| T&C analysis | fetches same-origin Terms/Refund links, scores sentences against 9 clause types, shows plain-language meaning |
| Dark patterns | pre-ticked add-ons, confirm-shaming, reversed opt-out wording, urgency/timers, lopsided accept/reject buttons |
| Alerts | on-page pill + list, outlines on the page, popup summary, click-to-jump |

## Known limits
- Rule-based, so expect false positives/negatives; English only.
- T&C is only fetched when the link is on the same site (browser cross-origin rules).
- Text inside iframes and images is not analysed.

## Ideas for next steps
- LLM-based T&C summaries via a small backend (needs user consent for sending text off-device).
- Per-site allowlist, "report a false positive", localisation (Hindi etc.).
