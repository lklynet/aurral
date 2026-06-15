use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use url::Url;

const STORE_PATH: &str = "settings.json";
const SERVER_URL_KEY: &str = "server_url";
const CHANGE_SERVER_MENU_ID: &str = "change_server";

fn normalize_server_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Server URL is required.".into());
    }

    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let parsed =
        Url::parse(&with_scheme).map_err(|_| "Enter a valid server URL.".to_string())?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Server URL must use http or https.".into());
    }

    if parsed.host_str().is_none() {
        return Err("Enter a valid server URL.".into());
    }

    Ok(parsed)
}

fn canonical_server_url(url: &Url) -> String {
    let mut normalized = url.clone();
    normalized.set_path("");
    normalized.set_query(None);
    normalized.set_fragment(None);
    normalized.to_string().trim_end_matches('/').to_string()
}

fn stored_server_url(app: &AppHandle) -> Option<Url> {
    let store = app.store(STORE_PATH).ok()?;
    let value = store.get(SERVER_URL_KEY)?;
    let url_str = value.as_str()?.to_string();
    normalize_server_url(&url_str).ok()
}

fn save_server_url(app: &AppHandle, url: &Url) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(
        SERVER_URL_KEY.to_string(),
        serde_json::Value::String(canonical_server_url(url)),
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_server_url(app: &AppHandle) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.delete(SERVER_URL_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

fn same_origin(request_url: &Url, server_url: &Url) -> bool {
    request_url.scheme() == server_url.scheme()
        && request_url.host() == server_url.host()
        && request_url.port_or_known_default() == server_url.port_or_known_default()
}

fn should_allow_navigation(
    request_url: &Url,
    app: &AppHandle,
) -> bool {
    let scheme = request_url.scheme();
    if scheme != "http" && scheme != "https" {
        return true;
    }

    let Some(server_url) = stored_server_url(app) else {
        return true;
    };

    if same_origin(request_url, &server_url) {
        return true;
    }

    let _ = app
        .opener()
        .open_url(request_url.as_str(), None::<&str>);
    false
}

fn navigate_to_server(window: &tauri::WebviewWindow, url: &Url) -> Result<(), String> {
    window.navigate(url.clone()).map_err(|e| e.to_string())
}

fn navigate_to_setup(window: &tauri::WebviewWindow) -> Result<(), String> {
    let setup_url = Url::parse("tauri://localhost")
        .map_err(|e| e.to_string())?;
    window.navigate(setup_url).map_err(|e| e.to_string())
}

fn reset_connection(app: &AppHandle) -> Result<(), String> {
    clear_server_url(app)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found.".to_string())?;
    navigate_to_setup(&window)
}

#[tauri::command]
fn connect_server(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = normalize_server_url(&url)?;
    save_server_url(&app, &parsed)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found.".to_string())?;
    navigate_to_server(&window, &parsed)
}

#[tauri::command]
fn reset_server(app: AppHandle) -> Result<(), String> {
    reset_connection(&app)
}

#[tauri::command]
fn get_server_url(app: AppHandle) -> Result<Option<String>, String> {
    Ok(stored_server_url(&app).map(|url| canonical_server_url(&url)))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let change_server = MenuItem::with_id(
        app,
        CHANGE_SERVER_MENU_ID,
        "Change Server…",
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Aurral",
        true,
        &[
            &change_server,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let navigation_app = app.handle().clone();
            let start_url = match stored_server_url(app.handle()) {
                Some(url) => WebviewUrl::External(url),
                None => WebviewUrl::App("index.html".into()),
            };

            WebviewWindowBuilder::new(app, "main", start_url)
                .title("Aurral")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .on_navigation(move |request_url| should_allow_navigation(&request_url, &navigation_app))
                .build()?;

            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHANGE_SERVER_MENU_ID {
                let _ = reset_connection(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect_server,
            reset_server,
            get_server_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
