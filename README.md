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
| Capture browser Back (Alt+Left) | on | Alt+Left / the browser's Back button also step back through sheets. Off = they get Foundry's usual "exit the game?" confirm. The mouse Back button is always handled. |

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
- Some browsers (Firefox) don't let a page cancel the mouse Back button and do a real history Back instead. In the game view Foundry keeps a guard history entry and answers `popstate` with an "exit the game?" `confirm()`. This module adds its own `popstate` listener at `init` in the capture phase, ahead of Foundry's. It swallows the event, re-adds the guard entry and steps back through sheets, so no prompt appears and the page stays. If one press arrives as both a mouse event and a `popstate`, it counts as a single step.
- Browsers skip history entries the user never interacted with when going Back. In Firefox this is `browser.navigation.requireUserInteraction`. Foundry adds its guard entry during load, so Back can jump straight past it and leave the game. This module adds its own guard entry on your first click or keypress instead, so Back lands on a same-page entry it can catch.
