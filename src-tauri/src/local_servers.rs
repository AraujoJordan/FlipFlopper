//! Listening local TCP servers for the preview panel. Read-only discovery via
//! `lsof`; no process is started or stopped here.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListeningServer {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    pub address: String,
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN -FpcPn` machine-readable output.
fn parse_lsof(output: &str) -> Vec<ListeningServer> {
    let mut pid = 0u32;
    let mut process = String::new();
    let mut servers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in output.lines() {
        let Some((tag, value)) = line.split_at_checked(1) else { continue };
        match tag {
            "p" => pid = value.parse().unwrap_or(0),
            "c" => process = value.to_string(),
            "n" => {
                let address = value.trim();
                let port_text = address.rsplit(':').next().unwrap_or("");
                let Ok(port) = port_text.parse::<u16>() else { continue };
                if port == 0 || !seen.insert(port) { continue; }
                servers.push(ListeningServer {
                    port,
                    pid,
                    process: if process.is_empty() { "unknown".into() } else { process.clone() },
                    address: address.to_string(),
                });
            }
            _ => {}
        }
    }
    servers.sort_by_key(|server| server.port);
    servers
}

/// Local TCP listeners, deduplicated by port. Empty when `lsof` is unavailable.
pub fn list() -> Vec<ListeningServer> {
    let Some(lsof) = crate::env::resolve_executable("lsof") else { return Vec::new() };
    let Ok(output) = Command::new(lsof)
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcPn"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_lsof(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_records_and_deduplicates_ports() {
        let output = "p120\ncnode\nn127.0.0.1:5173\np121\ncpostgres\nn[::1]:5432\np122\ncnode\nn*:5173\n";
        let servers = parse_lsof(output);
        assert_eq!(servers.len(), 2);
        assert_eq!((servers[0].port, servers[0].process.as_str()), (5173, "node"));
        assert_eq!((servers[1].port, servers[1].process.as_str()), (5432, "postgres"));
        assert!(parse_lsof("garbage\n").is_empty());
    }
}
