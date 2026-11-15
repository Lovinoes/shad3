//! Streams objects to the image/video/audio viewer from a tiny HTTP server on 127.0.0.1.
//! The webview's own network stack does the requests, so Range (video seeking) works like on
//! any website, and loopback counts as a secure origin, so http endpoints work too.
//! URL: http://127.0.0.1:<port>/<token>/<profile id>/<hex of key>

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::App;

/// Binds the server and returns its base URL ("http://127.0.0.1:port/token").
pub fn start(app: AppHandle) -> std::io::Result<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    // Unguessable per run, so other programs on this machine can't read the buckets.
    // RandomState keys come from the OS random generator; two hashes give 128 bits.
    let token = Arc::new(format!("{:016x}{:016x}", RandomState::new().hash_one(1u8), RandomState::new().hash_one(2u8)));
    let base = format!("http://127.0.0.1:{port}/{token}");
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        while let Ok((sock, _)) = listener.accept().await {
            tokio::spawn(handle(app.clone(), token.clone(), sock));
        }
    });
    Ok(base)
}

pub fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    let bytes = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

async fn handle(app: AppHandle, token: Arc<String>, mut sock: TcpStream) {
    let (r, mut w) = sock.split();
    let mut reader = BufReader::new(r);
    let (mut line, mut range) = (String::new(), None);
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    loop {
        let mut h = String::new();
        match reader.read_line(&mut h).await {
            Ok(0) | Err(_) => break,
            Ok(_) if h.trim().is_empty() => break,
            Ok(_) => {
                if let Some((k, v)) = h.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("range") {
                        range = Some(v.trim().to_owned());
                    }
                }
            }
        }
    }
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut segs = target.trim_start_matches('/').split('/');
    let (tok, id, key) = (segs.next(), segs.next(), segs.next().and_then(unhex));

    // The app page runs on another origin (tauri://localhost), so viewers that fetch() the file
    // (PDF, spreadsheets) need CORS. Safe: nothing is served without the secret token.
    let head = |status: &str, extra: &str| {
        format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\n\
             Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n{extra}\r\n"
        )
    };
    let fail = |status: &str, msg: &str| format!("{}{msg}", head(status, &format!("Content-Type: text/plain\r\nContent-Length: {}\r\n", msg.len())));

    let reply = async {
        if tok != Some(token.as_str()) {
            return Err(fail("403 Forbidden", "bad token"));
        }
        if method == "OPTIONS" {
            // Preflight for Range requests.
            return Err(head("204 No Content", "Access-Control-Allow-Methods: GET, HEAD\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 600\r\n"));
        }
        if method != "GET" && method != "HEAD" {
            return Err(fail("405 Method Not Allowed", "GET only"));
        }
        let (Some(id), Some(key)) = (id, key) else { return Err(fail("400 Bad Request", "bad path")) };
        let (c, bucket) = app.state::<App>().conn(id).map_err(|e| fail("404 Not Found", &e))?;
        let o = c.get_object().bucket(&bucket).key(&key).set_range(range).send().await.map_err(|e| fail("502 Bad Gateway", &crate::s3::fmt_err(e)))?;
        // The extension is more reliable than what uploaders set (often application/octet-stream).
        let mime = mime_guess::from_path(&key).first().map(|m| m.to_string()).or(o.content_type().map(str::to_owned)).unwrap_or("application/octet-stream".into());
        let mut extra = format!("Content-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n", o.content_length().unwrap_or(0));
        let status = match o.content_range() {
            Some(cr) => {
                extra += &format!("Content-Range: {cr}\r\n");
                "206 Partial Content"
            }
            None => "200 OK",
        };
        Ok((head(status, &extra), o.body))
    }
    .await;

    match reply {
        Err(msg) => {
            let _ = w.write_all(msg.as_bytes()).await;
        }
        Ok((header, mut body)) => {
            if w.write_all(header.as_bytes()).await.is_err() || method == "HEAD" {
                return;
            }
            // Streams chunk by chunk; when the player seeks it hangs up and the S3 download stops with it.
            while let Some(Ok(chunk)) = body.next().await {
                if w.write_all(&chunk).await.is_err() {
                    return;
                }
            }
        }
    }
    let _ = w.shutdown().await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn unhex() {
        assert_eq!(super::unhex("612f62c3a4").as_deref(), Some("a/bä"));
        assert_eq!(super::unhex("6"), None);
        assert_eq!(super::unhex("zz"), None);
        assert_eq!(super::unhex(&super::hex("dir/ä b.mp4")).as_deref(), Some("dir/ä b.mp4"));
    }
}
