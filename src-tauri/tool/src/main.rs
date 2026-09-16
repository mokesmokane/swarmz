fn main() {
    println!("{}", serde_json::json!({ "v": 1, "tool": env!("CARGO_PKG_VERSION"), "protocol": swarmz_tool::proto::PROTOCOL_VERSION }));
}
