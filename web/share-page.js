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
  const start = player.querySelector("[data-play-all]");
  const label = start.querySelector("[data-play-label]");
  const seek = player.querySelector("[data-seek]");
  const elapsed = player.querySelector("[data-elapsed]");
  const duration = player.querySelector("[data-duration]");
  const status = player.querySelector("[data-play-status]");
  let current = Math.max(
    0,
    tracks.findIndex((track) => !track.dataset.preview),
  );
  let selected = false;
  const time = (seconds) =>
    Number.isFinite(seconds)
      ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
      : "0:00";
  const select = (index) => {
    selected = true;
    current = index;
    tracks.forEach((track, position) =>
      track.setAttribute("aria-current", String(position === index)),
    );
    const row = tracks[index].closest("li");
    if (row) row.hidden = false;
    seek.disabled = true;
    seek.value = "0";
    elapsed.textContent = "0:00";
    duration.textContent = tracks[index].dataset.preview ? "0:30" : "0:00";
    status.hidden = true;
    audio.src = tracks[index].dataset.src;
    audio.play().catch(() => {});
  };
  const sync = () => {
    start.setAttribute("aria-pressed", String(!audio.paused));
    label.textContent = audio.paused ? start.dataset.label : "Pause";
    elapsed.textContent = time(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seek.disabled = false;
      seek.value = String((audio.currentTime / audio.duration) * 100);
      duration.textContent = time(audio.duration);
    }
  };
  start.addEventListener("click", () => {
    if (!audio.paused) audio.pause();
    else if (selected) audio.play().catch(() => {});
    else select(current);
  });
  tracks.forEach((track, index) =>
    track.addEventListener("click", () => {
      if (index === current && selected) {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
      } else select(index);
    }),
  );
  for (const event of ["playing", "pause", "timeupdate", "loadedmetadata", "ended"])
    audio.addEventListener(event, sync);
  audio.addEventListener("playing", () => {
    status.hidden = true;
  });
  audio.addEventListener("error", () => {
    status.textContent = tracks[current]?.dataset.preview
      ? "No preview is available for this track. Try a streaming service."
      : "The shared file is unavailable. Try again when the share is online.";
    status.hidden = false;
  });
  audio.addEventListener("ended", () => {
    if (tracks[current]?.dataset.preview) return;
    const next = tracks.findIndex((track, index) => index > current && !track.dataset.preview);
    if (next >= 0) select(next);
  });
  seek.addEventListener("input", () => {
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
        row.hidden = !expanded;
      });
      more.setAttribute("aria-expanded", String(expanded));
      more.textContent = expanded ? "Show fewer" : more.dataset.label;
    });
  }
  start.hidden = false;
  player.querySelector("[data-transport]").hidden = false;
  document.documentElement.classList.add("js");
}
