//! Read-only OOXML previews for the Files tab. Office files are ZIP archives
//! containing XML; this module extracts readable paragraphs, slide text and
//! worksheet rows without launching an Office application.

use quick_xml::events::{BytesCData, BytesRef, BytesStart, BytesText, Event};
use quick_xml::Reader;
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

const MAX_TEXT: usize = 200_000;
const MAX_XML: usize = 16 * 1024 * 1024;
const MAX_SHEETS: usize = 8;
const MAX_ROWS: usize = 200;
const MAX_COLUMNS: usize = 40;

#[derive(Debug, Clone, Serialize)]
pub struct OfficeSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OfficePreview {
    /// "docx" | "xlsx" | "pptx"
    pub kind: String,
    pub text: String,
    pub sheets: Vec<OfficeSheet>,
}

fn push_text(output: &mut String, text: &str) {
    if output.len() >= MAX_TEXT { return; }
    let remaining = MAX_TEXT - output.len();
    output.extend(text.chars().take(remaining));
}

fn reference_text(reference: &BytesRef) -> String {
    let name = reference.decode().unwrap_or_default().to_string();
    match name.as_str() {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        _ => {
            let numeric = name.strip_prefix('#').and_then(|rest| {
                if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    rest.parse::<u32>().ok()
                }
            });
            numeric.and_then(char::from_u32).map(String::from).unwrap_or_else(|| format!("&{name};"))
        }
    }
}

fn text_event(text: &BytesText, output: &mut String) {
    if let Ok(value) = text.decode() { push_text(output, &value); }
}

fn cdata_event(text: &BytesCData, output: &mut String) {
    if let Ok(value) = text.decode() { push_text(output, &value); }
}

/// Word paragraphs become newlines; tabs and explicit breaks are preserved.
pub fn docx_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) if in_text => text_event(&text, &mut output),
            Ok(Event::CData(text)) if in_text => cdata_event(&text, &mut output),
            Ok(Event::GeneralRef(reference)) if in_text => push_text(&mut output, &reference_text(&reference)),
            Ok(Event::Start(event)) => match event.local_name().as_ref() {
                b"t" => in_text = true,
                b"tab" => output.push('\t'),
                b"br" => output.push('\n'),
                _ => {}
            },
            Ok(Event::Empty(event)) => match event.local_name().as_ref() {
                b"tab" => output.push('\t'),
                b"br" => output.push('\n'),
                _ => {}
            },
            Ok(Event::End(event)) => match event.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => output.push('\n'),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    output.trim().to_string()
}

/// PowerPoint slide text: paragraphs become newlines.
pub fn pptx_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) if in_text => text_event(&text, &mut output),
            Ok(Event::CData(text)) if in_text => cdata_event(&text, &mut output),
            Ok(Event::GeneralRef(reference)) if in_text => push_text(&mut output, &reference_text(&reference)),
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" => in_text = true,
            Ok(Event::End(event)) => match event.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => output.push('\n'),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    output.trim().to_string()
}

fn attribute(event: &BytesStart, name: &str) -> Option<String> {
    event.try_get_attribute(name).ok().flatten()?.unescape_value().ok().map(|value| value.into_owned())
}

pub fn column_index(reference: &str) -> Option<usize> {
    let mut index = 0usize;
    let mut letters = 0;
    for ch in reference.chars() {
        if ch.is_ascii_alphabetic() {
            index = index.checked_mul(26)?.checked_add((ch.to_ascii_uppercase() as usize) - 64)?;
            letters += 1;
        } else {
            break;
        }
    }
    if letters == 0 { return None; }
    Some(index - 1)
}

/// Shared string table used by `t="s"` cell references.
pub fn xlsx_shared_strings(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" => in_text = true,
            Ok(Event::End(event)) if event.local_name().as_ref() == b"t" => in_text = false,
            Ok(Event::End(event)) if event.local_name().as_ref() == b"si" => {
                strings.push(std::mem::take(&mut current));
                if strings.len() >= 20_000 { break; }
            }
            Ok(Event::Text(text)) if in_text => text_event(&text, &mut current),
            Ok(Event::CData(text)) if in_text => cdata_event(&text, &mut current),
            Ok(Event::GeneralRef(reference)) if in_text => push_text(&mut current, &reference_text(&reference)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    strings
}

/// Worksheet rows with shared strings resolved. Empty trailing cells are trimmed.
pub fn xlsx_rows(xml: &str, shared: &[String]) -> Vec<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut column = 0usize;
    let mut cell_type = String::new();
    let mut value = String::new();
    let mut capture = false;
    let mut in_cell = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"row" => {
                row.clear();
            }
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) if event.local_name().as_ref() == b"c" => {
                column = attribute(&event, "r").and_then(|reference| column_index(&reference)).unwrap_or(row.len());
                cell_type = attribute(&event, "t").unwrap_or_default();
                value.clear();
                in_cell = true;
            }
            Ok(Event::Start(event)) if in_cell && matches!(event.local_name().as_ref(), b"v" | b"t") => capture = true,
            Ok(Event::End(event)) if in_cell && matches!(event.local_name().as_ref(), b"v" | b"t") => capture = false,
            Ok(Event::Text(text)) if capture => text_event(&text, &mut value),
            Ok(Event::CData(text)) if capture => cdata_event(&text, &mut value),
            Ok(Event::GeneralRef(reference)) if capture => push_text(&mut value, &reference_text(&reference)),
            Ok(Event::End(event)) if event.local_name().as_ref() == b"c" && in_cell => {
                if column < MAX_COLUMNS {
                    if row.len() <= column { row.resize(column + 1, String::new()); }
                    row[column] = if cell_type == "s" {
                        value.trim().parse::<usize>().ok().and_then(|index| shared.get(index)).cloned().unwrap_or_default()
                    } else {
                        std::mem::take(&mut value)
                    };
                }
                in_cell = false;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"row" => {
                while row.last().is_some_and(|cell| cell.is_empty()) { row.pop(); }
                if !row.is_empty() { rows.push(std::mem::take(&mut row)); }
                if rows.len() >= MAX_ROWS { break; }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    rows
}

pub fn sheet_names(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut names = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) if event.local_name().as_ref() == b"sheet" => {
                if let Some(name) = attribute(&event, "name") {
                    names.push(name);
                    if names.len() >= MAX_SHEETS { break; }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

fn zip_text(archive: &mut ZipArchive<File>, name: &str) -> Result<Option<String>, String> {
    let file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(format!("Couldn't read {name}: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_XML as u64).read_to_end(&mut bytes).map_err(|error| format!("Couldn't read {name}: {error}"))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn slide_number(name: &str) -> usize {
    name.rsplit('/').next().unwrap_or("").trim_start_matches("slide").trim_end_matches(".xml").parse().unwrap_or(0)
}

pub fn read(root: &str, path: &str) -> Result<OfficePreview, String> {
    let resolved = crate::project::resolve_inside(root, path)?;
    let extension = Path::new(&resolved).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "docx" | "xlsx" | "pptx") {
        return Err("This is not a supported Office document.".into());
    }
    let file = File::open(&resolved).map_err(|error| format!("Couldn't open {path}: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("Couldn't read the Office archive: {error}"))?;

    if extension == "docx" {
        let xml = zip_text(&mut archive, "word/document.xml")?.ok_or("This Word document has no readable body.")?;
        return Ok(OfficePreview { kind: "docx".into(), text: docx_text(&xml), sheets: Vec::new() });
    }

    if extension == "pptx" {
        let mut slides: Vec<String> = archive
            .file_names()
            .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
            .map(str::to_string)
            .collect();
        slides.sort_by_key(|name| slide_number(name));
        slides.truncate(50);
        let mut text = String::new();
        for (index, name) in slides.iter().enumerate() {
            if let Some(xml) = zip_text(&mut archive, name)? {
                push_text(&mut text, &format!("# Slide {}\n", index + 1));
                push_text(&mut text, &pptx_text(&xml));
                push_text(&mut text, "\n\n");
            }
        }
        return Ok(OfficePreview { kind: "pptx".into(), text: text.trim().to_string(), sheets: Vec::new() });
    }

    let shared = zip_text(&mut archive, "xl/sharedStrings.xml")?
        .map(|xml| xlsx_shared_strings(&xml))
        .unwrap_or_default();
    let names = zip_text(&mut archive, "xl/workbook.xml")?
        .map(|xml| sheet_names(&xml))
        .unwrap_or_default();
    let mut worksheets: Vec<(usize, String)> = archive
        .file_names()
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .map(|name| (slide_number(name), name.to_string()))
        .collect();
    worksheets.sort_by_key(|(index, _)| *index);
    worksheets.truncate(MAX_SHEETS);
    let mut sheets = Vec::new();
    for (index, (_, name)) in worksheets.iter().enumerate() {
        let Some(xml) = zip_text(&mut archive, name)? else { continue };
        let rows = xlsx_rows(&xml, &shared);
        sheets.push(OfficeSheet {
            name: names.get(index).cloned().unwrap_or_else(|| format!("Sheet {}", index + 1)),
            rows,
        });
    }
    Ok(OfficePreview { kind: "xlsx".into(), text: String::new(), sheets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_paragraphs_tabs_and_entities_are_extracted() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>Hello</w:t><w:tab/><w:t>A &amp; B</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>";
        assert_eq!(docx_text(xml), "Hello\tA & B\nWorld");
    }

    #[test]
    fn slides_and_columns_are_read() {
        let slide = "<p:sld><p:cSld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:cSld></p:sld>";
        assert_eq!(pptx_text(slide), "Title\nBody");
        assert_eq!(column_index("A1"), Some(0));
        assert_eq!(column_index("AB12"), Some(27));
        assert_eq!(column_index("1"), None);
    }

    #[test]
    fn sheet_rows_resolve_shared_strings_and_trim_trailing_cells() {
        let shared = r#"<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>"#;
        assert_eq!(xlsx_shared_strings(shared), ["Name", "Alice"]);
        let sheet = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"/></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>"#;
        assert_eq!(xlsx_rows(sheet, &xlsx_shared_strings(shared)), vec![
            vec!["Name".to_string(), "Alice".to_string()],
            vec!["42".to_string()],
        ]);
        assert_eq!(sheet_names(r#"<workbook><sheets><sheet name="Data" sheetId="1"/><sheet name="Summary" sheetId="2"/></sheets></workbook>"#), ["Data", "Summary"]);
    }
}
