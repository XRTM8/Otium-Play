use serde_json::Value;
use wasm_bindgen::{closure::Closure, JsCast};
use web_sys::{Document, Element, Event, HtmlElement, Window};

pub fn window() -> Window {
    web_sys::window().expect("browser window")
}
pub fn document() -> Document {
    window().document().expect("document")
}
pub fn el(id: &str) -> Element {
    document()
        .get_element_by_id(id)
        .unwrap_or_else(|| panic!("Missing UI element {id}"))
}
pub fn html(id: &str, value: &str) {
    el(id).set_inner_html(value);
}
pub fn text(id: &str, value: &str) {
    el(id).set_text_content(Some(value));
}
pub fn show(id: &str, visible: bool) {
    let _ = el(id).class_list().toggle_with_force("hidden", !visible);
}
pub fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
pub fn s(value: &Value, key: &str) -> String {
    match &value[key] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
pub fn on(id: &str, event: &str, f: impl FnMut(Event) + 'static) {
    listen(el(id).as_ref(), event, f);
}
pub fn listen(target: &web_sys::EventTarget, event: &str, f: impl FnMut(Event) + 'static) {
    let callback = Closure::wrap(Box::new(f) as Box<dyn FnMut(Event)>);
    target
        .add_event_listener_with_callback(event, callback.as_ref().unchecked_ref())
        .expect("event listener");
    callback.forget();
}
pub fn focus(id: &str) {
    if let Some(element) = document()
        .get_element_by_id(id)
        .and_then(|e| e.dyn_into::<HtmlElement>().ok())
    {
        let _ = element.focus();
    }
}
pub fn storage(key: &str) -> Option<String> {
    window()
        .local_storage()
        .ok()
        .flatten()?
        .get_item(key)
        .ok()
        .flatten()
}
pub fn store(key: &str, value: &str) {
    if let Ok(Some(storage)) = window().local_storage() {
        let _ = storage.set_item(key, value);
    }
}
