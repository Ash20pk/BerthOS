#!/usr/bin/env bash
# Regenerates berth_sdk/context_bus_pb2.py from proto/context_bus.proto
# (kept in sync by hand with packages/sdk/proto/context_bus.proto — the
# canonical copy, per that file's own header comment).
#
# Uses `python3 -m grpc_tools.protoc`, NOT a bare system `protoc` binary,
# for a real, discovered-the-hard-way reason: a system protoc (e.g. via
# Homebrew) tracks its own release train and can be materially newer than
# whatever `protobuf` version is published to PyPI for Python — generating
# code that then refuses to load at runtime
# (`google.protobuf.runtime_version.VersionError: gencode X, runtime Y`).
# grpcio-tools bundles a protoc release that's guaranteed compatible with
# the protobuf Python runtime it depends on, sidestepping that mismatch
# entirely. grpcio-tools is a codegen-time tool only — it is NOT a runtime
# dependency of this package (only `protobuf` itself is).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 -m grpc_tools.protoc --python_out=berth_sdk --proto_path=proto proto/context_bus.proto

echo "wrote berth_sdk/context_bus_pb2.py"
