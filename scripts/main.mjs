/**
 * Back Button Navigation
 *
 * Keeps a browser-style history of "where you were" among document sheets and lets the mouse
 * Back/Forward buttons step through it.
 *
 * A history entry is a sheet plus a snapshot of every tab group on it, e.g.
 *   { app, uuid, state: { "v1:0": "inventory", "v1:1": "encounter" } }
 * Keys are "v1:<index into app._tabs>" for ApplicationV1 Tabs controllers and "v2:<group>" for
 * ApplicationV2 tabGroups.
 *
 * Entries are recorded when:
 *  - a tracked sheet becomes the active window (observed via the ui.activeWindow property, which both
 *    V1 and V2 windows set when they render or are brought to the front), and
 *  - a tab changes on a tracked sheet (Tabs#activate for V1, ApplicationV2#changeTab for V2).
 */

const MODULE_ID = "back-button-navigation";
const BUTTON_BACK = 3;
const BUTTON_FORWARD = 4;

const nav = {
    /** @type {{app: object, uuid: string, state: Record<string, string>}[]} */
    entries: [],
    index: -1,
    /** True while a restore is applying synchronous tab/focus changes, so they are not recorded. */
    restoring: false,
    /** True while an async back/forward is in progress, to drop overlapping presses. */
    navigating: false,
    /** App whose last tab-change entry can still absorb more changes in the same task (e.g. PF2e openTab). */
    coalesceApp: null,
    /** Timestamp of the last mouse-button navigation, to ignore a popstate caused by the same press. */
    lastMouseNav: 0,
};

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function setting(key) {
    try {
        return game.settings.get(MODULE_ID, key);
    } catch {
        return undefined;
    }
}

function documentOf(app) {
    const doc = app?.document ?? app?.object;
    return doc && typeof doc.uuid === "string" ? doc : null;
}

/** Only framed windows that belong to a document (actor/item/journal/... sheets) are tracked. */
function isTracked(app) {
    if (!app || !documentOf(app)) return false;
    return Boolean(app.popOut ?? app.hasFrame);
}

function snapshot(app) {
    const state = {};
    if (Array.isArray(app._tabs)) {
        app._tabs.forEach((tabs, i) => {
            if (tabs?.active) state[`v1:${i}`] = tabs.active;
        });
    }
    if (app.tabGroups && typeof app.tabGroups === "object") {
        for (const [group, tab] of Object.entries(app.tabGroups)) {
            if (tab) state[`v2:${group}`] = tab;
        }
    }
    return state;
}

function current() {
    return nav.entries[nav.index] ?? null;
}

function push(app, state) {
    const cur = current();
    if (cur && cur.app === app) {
        if (foundry.utils.objectsEqual(cur.state, state)) return;
        if (nav.coalesceApp === app) {
            cur.state = state;
            return;
        }
    }

    // New navigation discards any "forward" history, like a browser.
    nav.entries.splice(nav.index + 1);
    nav.entries.push({ app, uuid: documentOf(app).uuid, state });

    const max = Math.max(2, Number(setting("historySize")) || 50);
    if (nav.entries.length > max) nav.entries.splice(0, nav.entries.length - max);
    nav.index = nav.entries.length - 1;
}

/* -------------------------------------------- */
/*  Recording                                   */
/* -------------------------------------------- */

function onFocus(app) {
    if (nav.restoring || !isTracked(app)) return;
    if (current()?.app === app) return;
    push(app, snapshot(app));
}

function onTabChange(app, key, previousTab) {
    if (nav.restoring || !isTracked(app)) return;
    const state = snapshot(app);

    // If this sheet isn't the current location (e.g. a tab switched on a background sheet), record
    // where it was first so Back can return to it.
    if (current()?.app !== app) push(app, { ...state, [key]: previousTab });

    push(app, state);

    // Several tab changes in one synchronous burst (PF2e's openTab switches the main tab and then a
    // sub-tab) become one history step.
    nav.coalesceApp = app;
    queueMicrotask(() => {
        if (nav.coalesceApp === app) nav.coalesceApp = null;
    });
}

function patchTabs() {
    const Tabs = foundry.applications.ux.Tabs;
    const original = Tabs.prototype.activate;
    Tabs.prototype.activate = function (tabName, options) {
        const previous = this.active;
        const result = original.call(this, tabName, options);
        try {
            if (previous && previous !== this.active && !nav.restoring) {
                const appId = this._nav?.closest("[data-appid]")?.dataset.appid;
                const app = appId ? ui.windows[appId] : null;
                const index = app?._tabs?.indexOf(this) ?? -1;
                if (index >= 0) onTabChange(app, `v1:${index}`, previous);
            }
        } catch (err) {
            console.error(`${MODULE_ID} | failed to record V1 tab change`, err);
        }
        return result;
    };
}

function patchChangeTab() {
    const ApplicationV2 = foundry.applications.api.ApplicationV2;
    const original = ApplicationV2.prototype.changeTab;
    ApplicationV2.prototype.changeTab = function (tab, group, options) {
        const previous = this.tabGroups?.[group];
        const result = original.call(this, tab, group, options);
        try {
            const next = this.tabGroups?.[group];
            if (previous && previous !== next && !nav.restoring) onTabChange(this, `v2:${group}`, previous);
        } catch (err) {
            console.error(`${MODULE_ID} | failed to record V2 tab change`, err);
        }
        return result;
    };
}

/**
 * Observe ui.activeWindow. Both V1 (on render) and V2 (on render and every pointerdown) assign it,
 * so this catches newly opened sheets as well as clicks on existing ones. Falls back to wrapping
 * bringToTop/bringToFront if the property can't be redefined.
 */
function observeActiveWindow() {
    const descriptor = Object.getOwnPropertyDescriptor(ui, "activeWindow");
    if (!descriptor || descriptor.configurable) {
        let value = ui.activeWindow ?? null;
        Object.defineProperty(ui, "activeWindow", {
            configurable: true,
            enumerable: true,
            get: () => value,
            set: (app) => {
                value = app;
                try {
                    if (app) onFocus(app);
                } catch (err) {
                    console.error(`${MODULE_ID} | failed to record focus`, err);
                }
            },
        });
        return;
    }

    console.warn(`${MODULE_ID} | ui.activeWindow is not configurable; falling back to wrapping focus methods`);
    const wrap = (cls, method) => {
        const original = cls.prototype[method];
        cls.prototype[method] = function (...args) {
            const result = original.apply(this, args);
            try {
                onFocus(this);
            } catch (err) {
                console.error(`${MODULE_ID} | failed to record focus`, err);
            }
            return result;
        };
    };
    wrap(foundry.appv1.api.Application, "bringToTop");
    wrap(foundry.applications.api.ApplicationV2, "bringToFront");
}

/* -------------------------------------------- */
/*  Restoring                                   */
/* -------------------------------------------- */

function applyState(app, state, live) {
    for (const [key, tab] of Object.entries(state)) {
        const separator = key.indexOf(":");
        const kind = key.slice(0, separator);
        const id = key.slice(separator + 1);

        if (kind === "v1") {
            const tabs = app._tabs?.[Number(id)];
            if (!tabs) continue;
            if (!live || !tabs._nav?.isConnected) tabs.active = tab; // picked up by Tabs#bind on next render
            else if (tabs.active !== tab) tabs.activate(tab, { triggerCallback: true });
        } else if (kind === "v2") {
            if (!app.tabGroups) continue;
            if (!live) app.tabGroups[id] = tab; // picked up by _prepareTabs on next render
            else if (app.tabGroups[id] !== tab) {
                try {
                    app.changeTab(tab, id);
                } catch {
                    // Tab no longer exists in this render (e.g. a conditional tab); ignore.
                }
            }
        }
    }
}

/** @returns {Promise<boolean>} false if the entry can't be restored and should be dropped. */
async function restore(entry) {
    let app = entry.app;

    if (!app.rendered) {
        if (!setting("reopenClosed")) return false;
        const doc = await fromUuid(entry.uuid);
        const sheet = doc?.sheet;
        if (!sheet) return false;
        if (sheet !== app) {
            for (const e of nav.entries) if (e.app === app) e.app = sheet;
            app = sheet;
        }
        applyState(app, entry.state, false);
        // Rendering sets ui.activeWindow, but onFocus ignores it because this entry is already current.
        app.render(true);
        return true;
    }

    if (app.minimized ?? app._minimized) await app.maximize();
    nav.restoring = true;
    try {
        if (typeof app.bringToFront === "function") app.bringToFront();
        else app.bringToTop?.();
        applyState(app, entry.state, true);
    } finally {
        nav.restoring = false;
    }
    return true;
}

async function go(delta) {
    if (nav.navigating) return;
    nav.navigating = true;
    const start = nav.index;
    const from = current();
    let removed = 0;
    try {
        let i = start + delta;
        while (i >= 0 && i < nav.entries.length) {
            const entry = nav.entries[i];
            // Skip steps that would land exactly where we already are (a no-op press).
            if (from?.app === entry.app && foundry.utils.objectsEqual(from.state, entry.state)) {
                i += delta;
                continue;
            }
            nav.index = i;
            nav.coalesceApp = null;
            let ok = false;
            try {
                ok = await restore(entry);
            } catch (err) {
                console.error(`${MODULE_ID} | failed to restore history entry`, err);
            }
            if (ok) return;

            // Drop entries for deleted documents / closed sheets and keep going in the same direction.
            nav.entries.splice(i, 1);
            removed++;
            if (delta < 0) i--;
        }
        // Nothing to go to: stay where we were.
        nav.index = Math.min(delta < 0 ? start - removed : start, nav.entries.length - 1);
    } finally {
        nav.navigating = false;
    }
}

/* -------------------------------------------- */
/*  Input                                       */
/* -------------------------------------------- */

function onMouseEvent(event) {
    const isBack = event.button === BUTTON_BACK;
    const isForward = event.button === BUTTON_FORWARD && setting("forwardButton");
    if (!isBack && !isForward) return;

    // Capture phase on window runs before Foundry's own listeners, so this also stops V2 windows from
    // bringing the window under the cursor to the front on pointerdown.
    event.stopPropagation();
    event.stopImmediatePropagation();
    // Don't cancel pointerdown: that would suppress the compatibility mousedown/mouseup events.
    if (event.type !== "pointerdown") event.preventDefault();

    if (event.type === "mouseup") {
        nav.lastMouseNav = Date.now();
        go(isBack ? -1 : 1);
    }
}

function onKeyDown(event) {
    if (event.key === "BrowserBack") {
        event.preventDefault();
        nav.lastMouseNav = Date.now();
        go(-1);
    } else if (event.key === "BrowserForward" && setting("forwardButton")) {
        event.preventDefault();
        nav.lastMouseNav = Date.now();
        go(1);
    }
}

/**
 * Keep a sentinel history entry on top so the browser's own Back (Alt+Left, browser button, or a
 * mouse whose Back press couldn't be cancelled) lands on it and we can turn it into a sheet Back.
 */
function guardBrowserHistory() {
    const sentinel = { [MODULE_ID]: true };
    history.pushState(sentinel, "", location.href);
    window.addEventListener("popstate", () => {
        history.pushState(sentinel, "", location.href);
        if (Date.now() - nav.lastMouseNav < 500) return; // already handled by the mouse/key listener
        go(-1);
    });
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

function registerSettings() {
    const register = (key, data) =>
        game.settings.register(MODULE_ID, key, {
            name: `BACK_BUTTON_NAV.Settings.${key}.Name`,
            hint: `BACK_BUTTON_NAV.Settings.${key}.Hint`,
            scope: "client",
            config: true,
            ...data,
        });

    register("historySize", { type: Number, default: 50, range: { min: 10, max: 200, step: 10 } });
    register("reopenClosed", { type: Boolean, default: true });
    register("forwardButton", { type: Boolean, default: true });
    register("captureBrowserBack", { type: Boolean, default: true, requiresReload: true });
}

Hooks.once("init", () => {
    registerSettings();
    patchTabs();
    patchChangeTab();
    observeActiveWindow();

    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick", "click"]) {
        window.addEventListener(type, onMouseEvent, { capture: true });
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });

    game.modules.get(MODULE_ID).api = {
        back: () => go(-1),
        forward: () => go(1),
        get history() {
            return { index: nav.index, entries: nav.entries.map(({ uuid, state }) => ({ uuid, state })) };
        },
    };
});

Hooks.once("ready", () => {
    if (setting("captureBrowserBack")) guardBrowserHistory();
});
