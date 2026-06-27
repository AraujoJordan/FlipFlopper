//! Native dialog helpers — replacements for browser alert/confirm/prompt.
//!
//! libui provides `modal_msg` and `modal_err` on `Window`.  For a
//! text-input dialog (rename commit), we show a small child `Window`.

use libui::controls::{Button, Entry, HorizontalBox, Label, VerticalBox, Window, WindowType};
use libui::prelude::*;

/// Show an informational message box (replaces `alert()`).
pub fn alert(win: &Window, title: &str, msg: &str) {
    win.modal_msg(title, msg);
}

/// Show an error message box.
pub fn error(win: &Window, title: &str, msg: &str) {
    win.modal_err(title, msg);
}

/// Show a yes/no confirmation dialog (replaces `confirm()`).
///
/// Returns `true` if the user clicked OK/Yes.
///
/// libui doesn't provide a built-in confirm dialog.  We show a small
/// modal Window with OK / Cancel buttons and drive its own nested main loop.
pub fn confirm(ui: &UI, win: &Window, title: &str, msg: &str) -> bool {
    let _ = win; // Window is required to own the dialog on some platforms
    let result = std::rc::Rc::new(std::cell::Cell::new(false));

    let mut dlg = Window::new(ui, title, 300, 100, WindowType::NoMenubar);
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    let lbl = Label::new(msg);
    vbox.append(lbl, LayoutStrategy::Stretchy);

    let mut hbox = HorizontalBox::new();
    hbox.set_padded(true);

    let result_ok = result.clone();
    let ui_ok = ui.clone();
    let mut btn_ok = Button::new("OK");
    btn_ok.on_clicked(move |_| {
        result_ok.set(true);
        ui_ok.quit();
    });

    let ui_cancel = ui.clone();
    let mut btn_cancel = Button::new("Cancel");
    btn_cancel.on_clicked(move |_| {
        ui_cancel.quit();
    });

    hbox.append(btn_ok, LayoutStrategy::Stretchy);
    hbox.append(btn_cancel, LayoutStrategy::Stretchy);
    vbox.append(hbox, LayoutStrategy::Compact);

    dlg.set_child(vbox);
    dlg.show();
    ui.main();

    result.get()
}

/// Show a text-input dialog (replaces `prompt()`).
///
/// Returns `Some(text)` if the user clicked OK, or `None` if cancelled.
pub fn prompt(ui: &UI, _win: &Window, title: &str, _placeholder: &str, default: &str) -> Option<String> {
    let result: std::rc::Rc<std::cell::RefCell<Option<String>>> =
        std::rc::Rc::new(std::cell::RefCell::new(None));

    let mut dlg = Window::new(ui, title, 400, 120, WindowType::NoMenubar);
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    let mut entry = Entry::new();
    entry.set_value(default);

    let result_ok = result.clone();
    let ui_ok = ui.clone();
    let entry_ok = entry.clone();
    let mut btn_ok = Button::new("OK");
    btn_ok.on_clicked(move |_| {
        *result_ok.borrow_mut() = Some(entry_ok.value());
        ui_ok.quit();
    });

    let ui_cancel = ui.clone();
    let mut btn_cancel = Button::new("Cancel");
    btn_cancel.on_clicked(move |_| {
        ui_cancel.quit();
    });

    let mut hbox = HorizontalBox::new();
    hbox.set_padded(true);
    hbox.append(btn_ok, LayoutStrategy::Stretchy);
    hbox.append(btn_cancel, LayoutStrategy::Stretchy);

    vbox.append(entry, LayoutStrategy::Compact);
    vbox.append(hbox, LayoutStrategy::Compact);

    dlg.set_child(vbox);
    dlg.show();
    ui.main();

    let val = result.borrow().clone();
    val
}
