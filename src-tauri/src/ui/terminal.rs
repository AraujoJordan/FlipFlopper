//! Area-backed terminal widget.
//!
//! Rendering strategy:
//!   - Each cell: fill a background rectangle, then draw the character.
//!   - Background via libui's safe `DrawContext::fill()`.
//!   - Text via raw `libui_ffi` FFI (`uiDrawText` + `uiAttributedString`).
//!
//! The `TerminalAreaHandler` is given to `Area::new()`.  The caller retains an
//! `Area` clone and calls `queue_redraw_all()` after new PTY bytes are
//! processed into the `Term` state.
//!
//! The `Term` + `Processor` live in `TabState` (state.rs); the handler holds
//! a shared `Rc<RefCell<AppState>>` and a session_id so it can read the grid.

use std::cell::RefCell;
use std::ffi::CString;
use std::rc::Rc;

use alacritty_terminal::{
    grid::Dimensions,
    vte::ansi::{Color, NamedColor},
};
use libui::controls::{Area, AreaDrawParams, AreaHandler, AreaKeyEvent, AreaMouseEvent};
use libui::draw::{Brush, DrawContext, Path, SolidBrush};

use super::state::AppState;

// ── Cell geometry ─────────────────────────────────────────────────────────────

/// Pixel size of one terminal cell.
pub const CELL_W: f64 = 9.0;
pub const CELL_H: f64 = 18.0;

// ── Colour conversion ─────────────────────────────────────────────────────────

/// 16-colour ANSI palette (sRGB 0..1).
fn ansi16(idx: u8, bright: bool) -> (f64, f64, f64) {
    // Standard xterm-256 palette first 16 entries
    let table: &[(f64, f64, f64)] = &[
        (0.0,   0.0,   0.0  ), // 0  Black
        (0.698, 0.0,   0.0  ), // 1  Red
        (0.0,   0.698, 0.0  ), // 2  Green
        (0.698, 0.698, 0.0  ), // 3  Yellow
        (0.0,   0.0,   0.698), // 4  Blue
        (0.698, 0.0,   0.698), // 5  Magenta
        (0.0,   0.698, 0.698), // 6  Cyan
        (0.749, 0.749, 0.749), // 7  White (light grey)
        (0.502, 0.502, 0.502), // 8  Bright Black (dark grey)
        (1.0,   0.0,   0.0  ), // 9  Bright Red
        (0.0,   1.0,   0.0  ), // 10 Bright Green
        (1.0,   1.0,   0.0  ), // 11 Bright Yellow
        (0.0,   0.0,   1.0  ), // 12 Bright Blue
        (1.0,   0.0,   1.0  ), // 13 Bright Magenta
        (0.0,   1.0,   1.0  ), // 14 Bright Cyan
        (1.0,   1.0,   1.0  ), // 15 Bright White
    ];
    let base = if bright { idx as usize + 8 } else { idx as usize };
    table[base.min(15)]
}

/// Convert `alacritty_terminal::vte::ansi::Color` to (r,g,b) ∈ [0,1].
pub fn color_to_rgb(color: &Color) -> (f64, f64, f64) {
    match color {
        Color::Named(n) => named_to_rgb(n),
        Color::Indexed(i) => indexed_to_rgb(*i),
        Color::Spec(rgb) => (rgb.r as f64 / 255.0, rgb.g as f64 / 255.0, rgb.b as f64 / 255.0),
    }
}

fn named_to_rgb(n: &NamedColor) -> (f64, f64, f64) {
    use NamedColor::*;
    match n {
        Black              => ansi16(0, false),
        Red                => ansi16(1, false),
        Green              => ansi16(2, false),
        Yellow             => ansi16(3, false),
        Blue               => ansi16(4, false),
        Magenta            => ansi16(5, false),
        Cyan               => ansi16(6, false),
        White              => ansi16(7, false),
        BrightBlack        => ansi16(0, true),
        BrightRed          => ansi16(1, true),
        BrightGreen        => ansi16(2, true),
        BrightYellow       => ansi16(3, true),
        BrightBlue         => ansi16(4, true),
        BrightMagenta      => ansi16(5, true),
        BrightCyan         => ansi16(6, true),
        BrightWhite        => ansi16(7, true),
        Foreground         => (0.878, 0.878, 0.878),    // default fg: #E0E0E0
        Background         => (0.067, 0.067, 0.078),    // default bg: #111113
        _                  => (0.5, 0.5, 0.5),
    }
}

/// xterm-256 colour index → sRGB.
fn indexed_to_rgb(idx: u8) -> (f64, f64, f64) {
    if idx < 16 {
        ansi16(idx % 8, idx >= 8)
    } else if idx < 232 {
        let i = idx - 16;
        let b = (i % 6) as f64 * 51.0 / 255.0;
        let g = ((i / 6) % 6) as f64 * 51.0 / 255.0;
        let r = (i / 36) as f64 * 51.0 / 255.0;
        (r, g, b)
    } else {
        let v = (idx - 232) as f64 * 10.0 / 255.0 + 8.0 / 255.0;
        (v, v, v)
    }
}

// ── Raw FFI text drawing ──────────────────────────────────────────────────────

/// Extract the raw `*mut uiDrawContext` from a libui `DrawContext`.
///
/// Safety: `DrawContext` is a newtype over a single `*mut uiDrawContext` field
/// at offset 0.  `size_of::<DrawContext>() == size_of::<*mut c_void>()` is
/// asserted to catch any layout change.
unsafe fn raw_ctx(ctx: &DrawContext) -> *mut libui_ffi::uiDrawContext {
    assert_eq!(
        std::mem::size_of::<DrawContext>(),
        std::mem::size_of::<*mut libui_ffi::uiDrawContext>(),
        "DrawContext layout changed — update raw_ctx()"
    );
    *(ctx as *const DrawContext as *const *mut libui_ffi::uiDrawContext)
}

/// Draw a single character at pixel position (x, y) with the given RGB colour.
///
/// Uses `uiDrawText` via raw FFI since the safe Rust wrapper doesn't yet
/// expose text drawing.
unsafe fn draw_char(
    ctx: &DrawContext,
    ch: char,
    x: f64,
    y: f64,
    r: f64,
    g: f64,
    b: f64,
) {
    use libui_ffi::*;

    let raw = raw_ctx(ctx);

    // Build an attributed string with one character.
    let s = {
        let mut buf = [0u8; 5];
        let encoded = ch.encode_utf8(&mut buf);
        CString::new(encoded.as_bytes()).unwrap_or_else(|_| CString::new(" ").unwrap())
    };
    let attr_str = uiNewAttributedString(s.as_ptr());

    // Apply foreground colour attribute over the single character.
    let color_attr = uiNewColorAttribute(r, g, b, 1.0);
    uiAttributedStringSetAttribute(attr_str, color_attr, 0, 1);

    // Build a font descriptor (monospace, 13pt).
    let font_family = CString::new("monospace").unwrap();
    let mut font_desc = uiFontDescriptor {
        Family: font_family.as_ptr() as *mut _,
        Size: 13.0,
        Weight: uiTextWeightNormal,
        Italic: uiTextItalicNormal,
        Stretch: uiTextStretchNormal,
    };

    // Build layout params.
    let params = uiDrawTextLayoutParams {
        String: attr_str,
        DefaultFont: &mut font_desc as *mut _,
        Width: CELL_W,
        Align: uiDrawTextAlignLeft,
    };

    let layout = uiDrawNewTextLayout(&params as *const _ as *mut _);
    uiDrawText(raw, layout, x, y);
    uiDrawFreeTextLayout(layout);
    uiFreeAttributedString(attr_str);
}

// ── AreaHandler implementation ────────────────────────────────────────────────

pub struct TerminalAreaHandler {
    pub session_id: String,
    pub state: Rc<RefCell<AppState>>,
    /// Reference to the owning PTY manager for send_input.
    pub pty_manager: std::sync::Arc<std::sync::Mutex<crate::pty::PtyManager>>,
}

impl AreaHandler for TerminalAreaHandler {
    fn draw(&mut self, _area: &Area, params: &AreaDrawParams) {
        let state = self.state.borrow();
        let Some(idx) = state.tab_index_by_id(&self.session_id) else { return };
        let tab = &state.tabs[idx];
        let term = &tab.term;
        let grid = term.grid();
        let rows = grid.screen_lines();
        let cols = grid.columns();

        let ctx = &params.context;

        // Fill full background.
        let (br, bg_r, bb) = named_to_rgb(&NamedColor::Background);
        let bg_path = Path::new(ctx, libui::draw::FillMode::Winding);
        bg_path.add_rectangle(ctx, 0.0, 0.0, params.area_width, params.area_height);
        bg_path.end(ctx);
        ctx.fill(
            &bg_path,
            &Brush::Solid(SolidBrush { r: br, g: bg_r, b: bb, a: 1.0 }),
        );

        // Draw each cell.
        for row in 0..rows {
            for col in 0..cols {
                use alacritty_terminal::index::{Column, Line};
                let cell = &grid[Line(row as i32)][Column(col)];
                let x = col as f64 * CELL_W;
                let y = row as f64 * CELL_H;

                // Cell background.
                let (cr, cg, cb) = color_to_rgb(&cell.bg);
                // Skip default background (already filled above).
                let is_default_bg = matches!(cell.bg, Color::Named(NamedColor::Background));
                if !is_default_bg {
                    let cell_path = Path::new(ctx, libui::draw::FillMode::Winding);
                    cell_path.add_rectangle(ctx, x, y, CELL_W, CELL_H);
                    cell_path.end(ctx);
                    ctx.fill(
                        &cell_path,
                        &Brush::Solid(SolidBrush { r: cr, g: cg, b: cb, a: 1.0 }),
                    );
                }

                // Character.
                if cell.c != ' ' && cell.c != '\0' {
                    let (fr, fg, fb) = color_to_rgb(&cell.fg);
                    unsafe {
                        draw_char(ctx, cell.c, x, y, fr, fg, fb);
                    }
                }
            }
        }

        // Draw cursor (simple filled rectangle at cursor position).
        let cursor_point = term.grid().cursor.point;
        let cx = cursor_point.column.0 as f64 * CELL_W;
        let cy = cursor_point.line.0 as f64 * CELL_H;
        let cursor_path = Path::new(ctx, libui::draw::FillMode::Winding);
        cursor_path.add_rectangle(ctx, cx, cy, CELL_W, CELL_H);
        cursor_path.end(ctx);
        ctx.fill(
            &cursor_path,
            &Brush::Solid(SolidBrush { r: 0.878, g: 0.878, b: 0.878, a: 0.4 }),
        );
    }

    fn key_event(&mut self, _area: &Area, event: &AreaKeyEvent) -> bool {
        let input = key_event_to_bytes(event);
        if !input.is_empty() {
            let mgr = self.pty_manager.lock().unwrap();
            let _ = crate::pty::send_input(&mgr, &self.session_id, &input);
        }
        true
    }

    fn mouse_event(&mut self, _area: &Area, _event: &AreaMouseEvent) {}
}

// ── Key translation ───────────────────────────────────────────────────────────

fn key_event_to_bytes(event: &AreaKeyEvent) -> String {
    use libui_ffi::*;

    // Regular printable character: event.key is ASCII u8, 0 means no char.
    if event.key != 0 {
        let ch = event.key as char;
        if !ch.is_control() {
            return ch.to_string();
        }
    }

    // Named / extended keys: event.ext_key is a uiExtKey (u32) constant.
    let ek = event.ext_key;
    if ek == uiExtKeyEscape   { return "\x1b".to_string(); }
    if ek == uiExtKeyInsert   { return "\x1b[2~".to_string(); }
    if ek == uiExtKeyDelete   { return "\x1b[3~".to_string(); }
    if ek == uiExtKeyHome     { return "\x1b[H".to_string(); }
    if ek == uiExtKeyEnd      { return "\x1b[F".to_string(); }
    if ek == uiExtKeyPageUp   { return "\x1b[5~".to_string(); }
    if ek == uiExtKeyPageDown { return "\x1b[6~".to_string(); }
    if ek == uiExtKeyUp       { return "\x1b[A".to_string(); }
    if ek == uiExtKeyDown     { return "\x1b[B".to_string(); }
    if ek == uiExtKeyLeft     { return "\x1b[D".to_string(); }
    if ek == uiExtKeyRight    { return "\x1b[C".to_string(); }
    if ek == uiExtKeyF1       { return "\x1bOP".to_string(); }
    if ek == uiExtKeyF2       { return "\x1bOQ".to_string(); }
    if ek == uiExtKeyF3       { return "\x1bOR".to_string(); }
    if ek == uiExtKeyF4       { return "\x1bOS".to_string(); }
    if ek == uiExtKeyF5       { return "\x1b[15~".to_string(); }
    if ek == uiExtKeyF6       { return "\x1b[17~".to_string(); }
    if ek == uiExtKeyF7       { return "\x1b[18~".to_string(); }
    if ek == uiExtKeyF8       { return "\x1b[19~".to_string(); }
    if ek == uiExtKeyF9       { return "\x1b[20~".to_string(); }
    if ek == uiExtKeyF10      { return "\x1b[21~".to_string(); }
    if ek == uiExtKeyF11      { return "\x1b[23~".to_string(); }
    if ek == uiExtKeyF12      { return "\x1b[24~".to_string(); }

    // Fall back: control characters (Ctrl+key sends the raw ASCII byte).
    if event.key != 0 {
        return (event.key as char).to_string();
    }
    String::new()
}
