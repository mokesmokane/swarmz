use std::collections::VecDeque;

pub const RING_CAP: usize = 2 * 1024 * 1024;
/// DECSTR soft reset, sent before a replay so modes left over in the viewer are cleared.
pub const REPLAY_PREFIX: &[u8] = b"\x1b[!p";

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    dropped: bool,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: VecDeque::with_capacity(cap.min(64 * 1024)), cap, dropped: false }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            self.dropped = true;
            return;
        }
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.dropped = true;
        }
        self.buf.extend(bytes);
    }

    /// What a new viewer should be shown. Once bytes have been dropped the ring may start inside
    /// an escape sequence or a line, so it replays from just after the first newline instead.
    pub fn replay(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let all: Vec<u8> = a.iter().chain(b.iter()).copied().collect();
        if !self.dropped {
            return all;
        }
        match all.iter().position(|&c| c == b'\n') {
            Some(i) => all[i + 1..].to_vec(),
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_until_full() {
        let mut r = Ring::new(16);
        r.push(b"abc\n");
        r.push(b"def");
        assert_eq!(r.replay(), b"abc\ndef");
    }

    #[test]
    fn after_dropping_it_replays_from_the_first_line_boundary() {
        let mut r = Ring::new(10);
        r.push(b"\x1b[31mred\nline2\n");
        // 15 bytes into 10: the oldest 5 are gone; replay starts after the first newline left.
        assert_eq!(r.replay(), b"line2\n");
    }

    #[test]
    fn a_push_larger_than_the_ring_keeps_its_tail() {
        let mut r = Ring::new(4);
        r.push(b"123456789");
        assert_eq!(r.replay(), b"");
        r.push(b"\nab");
        assert_eq!(r.replay(), b"ab");
    }

    #[test]
    fn prefix_is_a_soft_reset() {
        assert_eq!(REPLAY_PREFIX, b"\x1b[!p");
        assert_eq!(RING_CAP, 2 * 1024 * 1024);
    }
}
