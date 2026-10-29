import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  backSettings,
  closeSettings,
  openSettings,
  readSettingsPath,
} from "../../frontend/src/pages/Settings/settingsRoute.tsx";

type Entry = { pathname: string; search: string; hash: string; state: unknown };
type Step = number | { to: Omit<Entry, "state">; replace: boolean; state: unknown } | null;

function browserHistory(search = "") {
  const entries: Entry[] = [{ pathname: "/library", search, hash: "", state: null }];
  let index = 0;
  const current = () => entries[index];
  const go = (step: Step) => {
    if (typeof step === "number") index += step;
    else if (step?.replace) entries[index] = { ...step.to, state: step.state };
    else if (step) {
      entries.splice(index + 1, Infinity, { ...step.to, state: step.state });
      index += 1;
    }
  };
  return {
    path: () => readSettingsPath(current().search),
    open: (path: string) => go(openSettings(current(), path)),
    close: () => go(closeSettings(current())),
    back: () => go(backSettings(current())),
  };
}

test("closing settings returns to the page that opened it", () => {
  const history = browserHistory();
  history.open("");
  history.open("downloads");
  history.open("downloads/slskd");
  history.close();
  assert.equal(history.path(), null);
});

test("closing a settings page loaded from a link leaves settings", () => {
  const history = browserHistory("?settings=downloads");
  history.open("downloads/slskd");
  history.close();
  assert.equal(history.path(), null);
});

test("back goes to the parent even after switching sections", () => {
  const history = browserHistory();
  history.open("");
  history.open("downloads");
  history.open("downloads/slskd");
  history.open("profile");
  history.back();
  assert.equal(history.path(), "");

  history.open("downloads");
  history.open("downloads/slskd");
  history.back();
  assert.equal(history.path(), "downloads");
  history.close();
  assert.equal(history.path(), null);
});
