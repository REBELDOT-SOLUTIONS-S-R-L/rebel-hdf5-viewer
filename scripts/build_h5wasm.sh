#!/usr/bin/env bash
# Requires Emscripten SDK 4.0.23 (source emsdk_env.sh), CMake, Node, and pnpm.
# Rebuild the pinned upstream package with a 3.5 GiB heap, including the
# unsigned JavaScript heap indexing required for allocations above 2 GiB.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

npm pack h5wasm@0.10.1 --pack-destination "$build_dir"
tar -xzf "$build_dir/h5wasm-0.10.1.tgz" -C "$build_dir"
sed -i '/-s ALLOW_MEMORY_GROWTH=1/a\    -s MAXIMUM_MEMORY=3584MB \\' \
  "$build_dir/package/CMakeLists.txt"

emcmake cmake -S "$build_dir/package" -B "$build_dir/build" \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir/build" --target hdf5_util hdf5_util_node -j 2
pnpm dlx esbuild@0.25.0 --bundle "$build_dir/package/dist/esm/hdf5_hl.js" \
  --outfile="$build_dir/package/dist/iife/h5wasm.js" \
  --format=iife --global-name=h5wasm

mkdir -p "$repo_dir/vendor"
tar -czf "$repo_dir/vendor/h5wasm-0.10.1-memory-3584mb.tgz" \
  -C "$build_dir" package
printf 'Rebuilt h5wasm with MAXIMUM_MEMORY=3584MB. Run pnpm install to update the lockfile.\n'
