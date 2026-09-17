//! This Mac's ssh host key fingerprints, for the pairing QR code (spec §7.2).
//!
//! The public host keys in `/etc/ssh/ssh_host_*_key.pub` are world-readable, so nothing here
//! needs privileges. `SHA256:` plus the unpadded base64 of the SHA-256 of the decoded key blob is
//! exactly what `ssh-keygen -lf` prints, and what the phone's `fingerprint()` computes from the
//! key a Mac offers, so the two can be compared directly.
//!
//! SHA-256 and base64 are written out here rather than pulled in as crates: the tool ships as a
//! small binary installed on every Mac, and these are the only two things it needs them for.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Where the public host keys live. `SWARMZ_SSH_HOST_KEY_DIR` overrides it, so a test never reads
/// the real `/etc/ssh`.
pub fn host_key_dir() -> PathBuf {
    match std::env::var_os("SWARMZ_SSH_HOST_KEY_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from("/etc/ssh"),
    }
}

/// Every `ssh_host_*_key.pub` in `dir`, as fingerprints, sorted and without duplicates. A file
/// that cannot be read, or a line that is not a public key, is skipped rather than failing the
/// lot: a Mac with three key types and one odd file still reports three fingerprints. A missing
/// directory is no keys.
///
/// These are the keys macOS generates and keeps in `/etc/ssh`, whatever `sshd_config` says: a
/// `HostKey` line naming a key elsewhere, or leaving one of these out, is not followed. In
/// practice sshd offers exactly these, and a fingerprint listed here that it never offers only
/// means one pin the phone never matches against, while the keys it does offer still verify.
pub fn fingerprints_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = BTreeSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("ssh_host_") && name.ends_with("_key.pub")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        for line in text.lines() {
            if let Some(fp) = fingerprint_of_line(line) {
                out.insert(fp);
            }
        }
    }
    out.into_iter().collect()
}

/// The fingerprint of one `<key type> <base64 blob> [comment]` line, or `None` when the line is
/// not a public key (a comment, a private key's armour, a blank line, unreadable base64).
pub fn fingerprint_of_line(line: &str) -> Option<String> {
    let mut words = line.split_whitespace();
    let key_type = words.next()?;
    // Every OpenSSH public key type: `ssh-rsa`, `ssh-ed25519`, `ecdsa-sha2-*`, `sk-*`.
    if !(key_type.starts_with("ssh-") || key_type.starts_with("ecdsa-") || key_type.starts_with("sk-")) {
        return None;
    }
    let blob = b64_decode(words.next()?)?;
    if blob.is_empty() {
        return None;
    }
    Some(format!("SHA256:{}", b64_encode_unpadded(&sha256(&blob))))
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64, with the `=` padding left off, as OpenSSH prints fingerprints.
pub fn b64_encode_unpadded(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as u32) << 16) | ((*chunk.get(1).unwrap_or(&0) as u32) << 8) | *chunk.get(2).unwrap_or(&0) as u32;
        // 3 bytes make 4 characters, 2 make 3, 1 makes 2; the rest would be padding.
        for shift in [18, 12, 6, 0].iter().take(chunk.len() + 1) {
            out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
        }
    }
    out
}

fn b64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Standard base64, with or without padding. `None` for anything that is not valid base64,
/// including a lone trailing character (which carries no whole byte) and leftover bits that are
/// not zero.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let body = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in body {
        acc = (acc << 6) | b64_value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 6 || acc & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(out)
}

#[rustfmt::skip]
const ROUND_CONSTANTS: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// FIPS 180-4 SHA-256.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());

    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(ROUND_CONSTANTS[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for (acc, add) in h.iter_mut().zip(v) {
            *acc = acc.wrapping_add(add);
        }
    }

    let mut out = [0u8; 32];
    for (bytes, word) in out.chunks_exact_mut(4).zip(h) {
        bytes.copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `ssh-keygen -t ed25519` / `-t rsa`, with the fingerprints `ssh-keygen -lf` printed for them.
    const ED25519: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPge3R3QFKHxzq6KmYIC6KzYNvdlN93DVMtK561x2P3x root@fixture";
    const ED25519_FP: &str = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U";
    const RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDsbYhsxRKkYgvHZKeNRhRVvfTfwODNFEaoBlEdeh2GlDKEupN0pfSKwKyj4vQESugdTd9CGG2z6c2Hl/DtS9GyfBQGpuXLkKT6HeM/XBPd7zlHTnPc8O54McBr7cURAH9OcXdTx6sowdybCTkuC8hRpL4LZfnmkhChHdyH4twO9rtGc+nUmWCXnwzkQzM78ToHJRnq5CH5mKgl+j4uktbf+WQbo3iKQTGY2aKzzlRMS/EoabXrnmzVrmDQmZ9wSkRWx0cqIJl9tX7lUvsMFC0pl7JtAb2HJycYN+BziV/hCQKOMLm0klYPMfgaj/N64TCbhQ2YBd5n1Qg/jHRAcLen root@fixture";
    const RSA_FP: &str = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0";

    fn tmp(tag: &str) -> PathBuf {
        let d = PathBuf::from(format!("/tmp/szc-{}-hostkeys-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sha256_matches_the_published_vectors() {
        let hex = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            hex(sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // Longer than one block, and a length that needs an extra padding block.
        assert_eq!(hex(sha256(&[b'a'; 1_000_000][..1000])), {
            let mut s = String::new();
            for b in [0x41u8, 0xed, 0xec, 0xe4, 0x2d, 0x63, 0xe8, 0xd9, 0xbf, 0x51, 0x5a, 0x9b, 0xa6, 0x93, 0x2e, 0x1c, 0x20, 0xcb, 0xc9, 0xf5, 0xa5, 0xd1, 0x34, 0x64, 0x5a, 0xdb, 0x5d, 0xb1, 0xb9, 0x73, 0x7e, 0xa3] {
                s.push_str(&format!("{b:02x}"));
            }
            s
        });
    }

    #[test]
    fn base64_round_trips_and_rejects_rubbish() {
        for n in 0..40usize {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            let text = b64_encode_unpadded(&bytes);
            assert!(!text.contains('='), "{text}");
            assert_eq!(b64_decode(&text).unwrap(), bytes, "n={n}");
        }
        // Padding is accepted on the way in.
        assert_eq!(b64_decode("YQ==").unwrap(), b"a");
        assert_eq!(b64_decode("YWI=").unwrap(), b"ab");
        assert_eq!(b64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(b64_decode(""), Some(vec![]));
        assert_eq!(b64_decode("!!!!"), None);
        // A lone trailing character carries no whole byte.
        assert_eq!(b64_decode("YWJjY"), None);
    }

    #[test]
    fn a_public_key_line_fingerprints_the_way_ssh_keygen_does() {
        assert_eq!(fingerprint_of_line(ED25519).as_deref(), Some(ED25519_FP));
        assert_eq!(fingerprint_of_line(RSA).as_deref(), Some(RSA_FP));
        // A key with no comment, and one with extra spacing.
        assert_eq!(fingerprint_of_line(ED25519.rsplit_once(' ').unwrap().0).as_deref(), Some(ED25519_FP));
        assert_eq!(fingerprint_of_line(&ED25519.replace(' ', "  ")).as_deref(), Some(ED25519_FP));
        // Not public key lines.
        assert_eq!(fingerprint_of_line(""), None);
        assert_eq!(fingerprint_of_line("# a comment"), None);
        assert_eq!(fingerprint_of_line("ssh-ed25519"), None);
        assert_eq!(fingerprint_of_line("ssh-ed25519 !!!!"), None);
        assert_eq!(fingerprint_of_line("-----BEGIN OPENSSH PRIVATE KEY-----"), None);
    }

    #[test]
    fn only_public_host_keys_in_the_directory_are_read() {
        let d = tmp("dir");
        std::fs::write(d.join("ssh_host_ed25519_key.pub"), format!("{ED25519}\n")).unwrap();
        std::fs::write(d.join("ssh_host_rsa_key.pub"), format!("{RSA}\n")).unwrap();
        // Private keys, and everything else in /etc/ssh, are ignored.
        std::fs::write(d.join("ssh_host_ed25519_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        std::fs::write(d.join("sshd_config"), "PermitRootLogin no\n").unwrap();
        std::fs::write(d.join("ssh_host_broken_key.pub"), "not a key at all\n").unwrap();
        assert_eq!(fingerprints_in(&d), vec![RSA_FP.to_string(), ED25519_FP.to_string()]);
        // A missing directory is no keys, not an error.
        assert_eq!(fingerprints_in(&d.join("nope")), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_same_key_twice_is_listed_once() {
        let d = tmp("dupe");
        std::fs::write(d.join("ssh_host_ed25519_key.pub"), format!("{ED25519}\n")).unwrap();
        std::fs::write(d.join("ssh_host_copy_key.pub"), format!("{ED25519}\n")).unwrap();
        assert_eq!(fingerprints_in(&d), vec![ED25519_FP.to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
