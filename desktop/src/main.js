const { invoke } = window.__TAURI__.core;

let form;
let input;
let error;
let button;

function showError(message) {
  if (!message) {
    error.hidden = true;
    error.textContent = "";
    return;
  }
  error.hidden = false;
  error.textContent = message;
}

async function bootstrap() {
  try {
    const existing = await invoke("get_server_url");
    if (existing) {
      input.value = existing;
    }
  } catch {
    showError("");
  }
}

async function connect(event) {
  event.preventDefault();
  showError("");
  button.disabled = true;
  button.textContent = "Connecting…";

  try {
    await invoke("connect_server", { url: input.value });
  } catch (cause) {
    const message =
      typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : "Could not connect to that server.";
    showError(message);
    button.disabled = false;
    button.textContent = "Connect";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  form = document.getElementById("connect-form");
  input = document.getElementById("server-url");
  error = document.getElementById("error");
  button = document.getElementById("connect-button");
  form.addEventListener("submit", connect);
  bootstrap();
});
