use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    Welcome = 2,
    Replay = 3,
    Data = 4,
    Resize = 5,
    Exit = 6,
    Terminate = 7,
    Info = 8,
    InfoReply = 9,
}

impl Kind {
    pub fn from_u8(b: u8) -> Option<Kind> {
        Some(match b {
            1 => Kind::Hello,
            2 => Kind::Welcome,
            3 => Kind::Replay,
            4 => Kind::Data,
            5 => Kind::Resize,
            6 => Kind::Exit,
            7 => Kind::Terminate,
            8 => Kind::Info,
            9 => Kind::InfoReply,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn encode(kind: Kind, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind as u8);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn write_frame(w: &mut impl Write, kind: Kind, payload: &[u8]) -> io::Result<()> {
    w.write_all(&encode(kind, payload))
}

/// Reads one frame. `Ok(None)` on a clean end of stream before a frame starts.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        let n = r.read(&mut head[got..])?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        got += n;
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some(Frame { kind: head[0], payload }))
}

pub fn resize_payload(cols: u16, rows: u16) -> [u8; 4] {
    let c = cols.to_be_bytes();
    let r = rows.to_be_bytes();
    [c[0], c[1], r[0], r[1]]
}

pub fn parse_resize(p: &[u8]) -> Option<(u16, u16)> {
    if p.len() != 4 {
        return None;
    }
    Some((u16::from_be_bytes([p[0], p[1]]), u16::from_be_bytes([p[2], p[3]])))
}

pub fn json<T: Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).expect("protocol messages always serialise")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub v: u32,
    pub cols: u16,
    pub rows: u16,
    pub viewer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub v: u32,
    pub shell_pid: Option<u32>,
    pub cwd: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExitInfo {
    pub code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub cwd: Option<String>,
    pub foreground_busy: Option<bool>,
    pub foreground_command: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Data, b"hello").unwrap();
        write_frame(&mut buf, Kind::Terminate, b"").unwrap();
        assert_eq!(&buf[..5], &[4, 0, 0, 0, 5]);
        let mut r = Cursor::new(buf);
        let a = read_frame(&mut r).unwrap().unwrap();
        assert_eq!((a.kind, a.payload.as_slice()), (Kind::Data as u8, &b"hello"[..]));
        let b = read_frame(&mut r).unwrap().unwrap();
        assert_eq!((b.kind, b.payload.len()), (Kind::Terminate as u8, 0));
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn truncated_and_oversized_frames_are_errors() {
        let mut r = Cursor::new(vec![4u8, 0, 0]);
        assert!(read_frame(&mut r).is_err());
        let mut big = vec![4u8];
        big.extend_from_slice(&((MAX_FRAME as u32) + 1).to_be_bytes());
        assert!(read_frame(&mut Cursor::new(big)).is_err());
    }

    #[test]
    fn kinds_and_resize_payloads() {
        assert_eq!(Kind::from_u8(9), Some(Kind::InfoReply));
        assert_eq!(Kind::from_u8(42), None);
        assert_eq!(parse_resize(&resize_payload(132, 43)), Some((132, 43)));
        assert_eq!(parse_resize(&[1, 2, 3]), None);
    }

    #[test]
    fn messages_use_camel_case() {
        let w = Welcome { v: 1, shell_pid: Some(7), cwd: "/p".into(), started_at: "t".into() };
        let v: serde_json::Value = serde_json::from_slice(&json(&w)).unwrap();
        assert_eq!(v["shellPid"], 7);
        assert_eq!(v["startedAt"], "t");
        let i = Info { cwd: None, foreground_busy: Some(true), foreground_command: Some("sleep".into()) };
        let v: serde_json::Value = serde_json::from_slice(&json(&i)).unwrap();
        assert_eq!(v["foregroundBusy"], true);
        assert_eq!(v["foregroundCommand"], "sleep");
        let h: Hello = serde_json::from_str(r#"{"v":1,"cols":80,"rows":24,"viewer":"window"}"#).unwrap();
        assert_eq!(h.viewer, "window");
    }
}
