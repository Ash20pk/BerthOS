fn main() {
    // Requires a system `protoc` on PATH (`brew install protobuf` / `apk add
    // protobuf`). The daemon is normally built inside the Alpine Docker
    // image (see base.Dockerfile's context-bus-builder stage), which
    // installs protoc itself — this only matters for local `cargo build`.
    prost_build::compile_protos(&["proto/context_bus.proto"], &["proto"]).unwrap();
}
