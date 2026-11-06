#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the installed Android NDK directory}"
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
for spec in 'aarch64-linux-android:aarch64-linux-android24:arm64-v8a' 'armv7-linux-androideabi:armv7a-linux-androideabi24:armeabi-v7a' 'i686-linux-android:i686-linux-android24:x86' 'x86_64-linux-android:x86_64-linux-android24:x86_64'; do
  IFS=: read -r target clang_target abi <<< "$spec"
  key="${target//-/_}"
  env "CARGO_TARGET_${key^^}_LINKER=$toolchain/$clang_target-clang" \
      "CARGO_TARGET_${key^^}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384" \
      "CC_$key=$toolchain/$clang_target-clang" "AR_$key=$toolchain/llvm-ar" \
      cargo build --manifest-path "$project_root/rust/otium-core/Cargo.toml" --locked --release --lib --target "$target"
  mkdir -p "$project_root/android/app/src/main/jniLibs/$abi"
  cp "$project_root/rust/otium-core/target/$target/release/libotium_core.so" "$project_root/android/app/src/main/jniLibs/$abi/libotium_core.so"
done
