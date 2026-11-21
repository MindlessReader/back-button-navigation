# Back Button Navigation

Makes the mouse **Back** / **Forward** buttons work like a browser's history, but for sheets:

- go back to the previous tab of the current sheet (including sub-tabs, e.g. PF2e's Actions → Encounter/Exploration/Downtime)
- go back to the previously focused sheet
- reopen a sheet you've since closed, on the tab it was on

Instead of navigating the browser away from `/game`.

Foundry v13 (verified 13.351). Works with any system; tested against PF2e 7.12's sheets.

## What is tracked

Any framed window that belongs to a document: actor, item, journal and token config sheets, etc. Dialogs, the sidebar and other non-document windows are ignored.

Each history step is a sheet plus the active tab in every tab group on it. A new step is recorded when a tracked sheet becomes the active window, or when a tab changes on one. Several tab changes in a single action (PF2e jumping straight to a sub-tab) count as one step.

## Settings (per client)

| Setting | Default | |
|---|---|---|
| History size | 50 | Steps remembered |
| Reopen closed sheets | on | Off = closed sheets are skipped |
| Use mouse Forward button | on | |
| Capture browser Back (Alt+Left) | on | Alt+Left / the browser's Back button also step back through sheets (reload required) |

## Macro API

```js
const api = game.modules.get("back-button-navigation").api;
api.back();
api.forward();
api.history; // { index, entries: [{ uuid, state }] }
```

## How it works

- `foundry.applications.ux.Tabs#activate` (ApplicationV1 sheets) and `ApplicationV2#changeTab` are wrapped to record tab changes.
- `ui.activeWindow` is turned into an accessor property to observe focus. Both V1 (on render) and V2 (on render and every pointerdown) assign it.
- Mouse buttons 3/4 are handled in the capture phase on `window`, ahead of Foundry's own listeners, so the window under the cursor isn't brought to the front first.
- A sentinel `history.pushState` entry catches any browser Back navigation that couldn't be cancelled.
