//! Stamps the tool with a build id (seconds since the epoch at build time), so two builds that
//! share a version string can still be told apart when deciding whether to replace an installed
//! copy. Cargo re-runs this whenever the crate's sources change.
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=SWARMZ_BUILD_ID={secs}");
}
