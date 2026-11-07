@echo off
title ZOET by Otium
cd /d "%~dp0"
echo ZOET by Otium - http://localhost:3000
cargo run --manifest-path rust/otium-core/Cargo.toml --locked --release
pause
