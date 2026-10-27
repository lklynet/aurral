const root = document.querySelector("[data-aurral]");
if (root) {
  const key = "aurral:instance-url";
  const summary = root.querySelector("summary");
  const actions = root.querySelector("[data-aurral-actions]");
  const links = Array.from(root.querySelectorAll("[data-aurral-action]"));
  const server = root.querySelector("[data-aurral-server]");
  const address = server.querySelector("span");
  const form = root.querySelector("form");
  const input = form.querySelector("input");
  const error = form.querySelector("[role=alert]");
  const submit = form.querySelector("[type=submit]");
  let saved = null;
  let pending = null;
  const normalize = (value) => {
    let text = String(value || "").trim();
    if (!text) return null;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = "http://" + text;
    try {
      const url = new URL(text);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      return null;
    }
  };
  try {
    saved = normalize(localStorage.getItem(key));
  } catch {}
  const showActions = () => {
    actions.hidden = false;
    form.hidden = true;
    server.hidden = !saved;
    if (saved) address.textContent = saved.replace(/^https?:\/\//, "");
    for (const link of links) link.href = saved ? saved + link.dataset.path : "#aurral-url";
  };
  const showAddress = (link) => {
    pending = link;
    actions.hidden = true;
    form.hidden = false;
    input.value = saved || "";
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    submit.textContent = link?.textContent.trim() || "Save address";
    input.focus();
  };
  for (const link of links) {
    link.addEventListener("click", (event) => {
      if (saved) return;
      event.preventDefault();
      showAddress(link);
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = normalize(input.value);
    if (!value) {
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    saved = value;
    try {
      localStorage.setItem(key, value);
    } catch {}
    if (pending) window.location.assign(value + pending.dataset.path);
    else showActions();
  });
  root.querySelector("[data-change-address]").addEventListener("click", () => showAddress(null));
  root.querySelector("[data-aurral-back]").addEventListener("click", () => {
    showActions();
    (pending || links[0]).focus();
    pending = null;
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      root.open = false;
      summary.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) root.open = false;
  });
  showActions();
  root.hidden = false;
}

document.querySelectorAll("img[data-fallback]").forEach((img) => {
  const fallback = () => {
    img.parentElement.textContent = img.dataset.fallback;
  };
  img.addEventListener("error", fallback);
  if (img.complete && !img.naturalWidth) fallback();
});

const player = document.querySelector("[data-player]");
if (player) {
  const audio = player.querySelector("audio");
  const tracks = Array.from(player.querySelectorAll("[data-src]"));
  const playAll = player.querySelector("[data-play-all]");
  const shuffle = player.querySelector("[data-shuffle]");
  const now = player.querySelector("[data-now]");
  const title = now.querySelector("[data-now-title]");
  const toggle = now.querySelector("[data-toggle]");
  const previous = now.querySelector("[data-previous]");
  const next = now.querySelector("[data-next]");
  const seek = now.querySelector("[data-seek]");
  const elapsed = now.querySelector("[data-elapsed]");
  const duration = now.querySelector("[data-duration]");
  const status = player.querySelector("[data-play-status]");
  const playable = tracks.some((track) => !track.dataset.preview)
    ? tracks.filter((track) => !track.dataset.preview)
    : tracks;
  let order = playable;
  let current = null;
  const time = (seconds) =>
    Number.isFinite(seconds)
      ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
      : "0:00";
  const select = (track) => {
    current = track;
    for (const entry of tracks) {
      entry.setAttribute("aria-current", String(entry === track));
      entry.setAttribute("aria-pressed", "false");
      entry.setAttribute("aria-label", `Play ${entry.dataset.title}`);
    }
    const row = track.closest("li");
    if (row) row.hidden = false;
    title.textContent = track.dataset.title;
    seek.disabled = true;
    seek.value = "0";
    seek.style.setProperty("--progress", "0%");
    elapsed.textContent = "0:00";
    duration.textContent = track.dataset.preview ? "0:30" : "0:00";
    status.hidden = true;
    now.hidden = false;
    document.body.classList.add("has-now");
    audio.src = track.dataset.src;
    audio.play().catch(() => {});
  };
  const step = (offset) => {
    if (!current) return;
    const list = order.includes(current) ? order : tracks;
    const target = list[list.indexOf(current) + offset];
    if (target) select(target);
  };
  const sync = () => {
    const playing = !audio.paused;
    toggle.setAttribute("aria-pressed", String(playing));
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (current) {
      current.setAttribute("aria-pressed", String(playing));
      current.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${current.dataset.title}`);
    }
    elapsed.textContent = time(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seek.disabled = false;
      seek.value = String((audio.currentTime / audio.duration) * 100);
      seek.style.setProperty("--progress", `${seek.value}%`);
      duration.textContent = time(audio.duration);
    }
  };
  const resume = () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };
  playAll.addEventListener("click", () => {
    order = playable;
    select(order[0]);
  });
  shuffle?.addEventListener("click", () => {
    order = [...playable];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    select(order[0]);
  });
  for (const track of tracks)
    track.addEventListener("click", () => {
      if (track === current) resume();
      else select(track);
    });
  toggle.addEventListener("click", resume);
  previous?.addEventListener("click", () => {
    if (audio.currentTime > 3) audio.currentTime = 0;
    else step(-1);
  });
  next?.addEventListener("click", () => step(1));
  for (const event of ["playing", "pause", "timeupdate", "loadedmetadata", "ended"])
    audio.addEventListener(event, sync);
  audio.addEventListener("playing", () => {
    status.hidden = true;
  });
  audio.addEventListener("error", () => {
    if (!current) return;
    status.textContent = current.dataset.preview
      ? "No preview is available for this track. Try a streaming service."
      : "The shared file is unavailable. Try again when the share is online.";
    status.hidden = false;
  });
  audio.addEventListener("ended", () => {
    if (order.includes(current)) step(1);
  });
  seek.addEventListener("input", () => {
    seek.style.setProperty("--progress", `${seek.value}%`);
    if (Number.isFinite(audio.duration))
      audio.currentTime = (Number(seek.value) / 100) * audio.duration;
  });
  const more = player.querySelector("[data-show-tracks]");
  if (more) {
    const rows = Array.from(player.querySelectorAll("[data-extra-track]"));
    rows.forEach((row) => {
      row.hidden = true;
    });
    more.hidden = false;
    more.addEventListener("click", () => {
      const expanded = more.getAttribute("aria-expanded") !== "true";
      rows.forEach((row) => {
        row.hidden = !expanded && !row.contains(current);
      });
      more.setAttribute("aria-expanded", String(expanded));
      more.textContent = expanded ? "Show fewer" : more.dataset.label;
    });
  }
  playAll.hidden = false;
  if (shuffle) shuffle.hidden = playable.length < 2;
  document.documentElement.classList.add("js");
}
