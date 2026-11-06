@echo off
title Otium Play
cd /d "%~dp0"
echo Otium Play - http://localhost:3000
cargo run --manifest-path rust/otium-core/Cargo.toml --locked --release
pause
