param(
    [string]$NdkPath = $env:ANDROID_NDK_HOME,
    [ValidateSet('arm64-v8a','armeabi-v7a','x86','x86_64')][string[]]$Abis = @('arm64-v8a','armeabi-v7a','x86','x86_64'),
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $NdkPath) {
    $sdkPath = $env:ANDROID_HOME
    if (-not $sdkPath) { $sdkPath = Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk' }
    $NdkPath = (Get-ChildItem -LiteralPath (Join-Path $sdkPath 'ndk') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
}
if (-not $NdkPath) { throw 'Install Android NDK or set ANDROID_NDK_HOME.' }
$toolchain = Join-Path $NdkPath 'toolchains\llvm\prebuilt\windows-x86_64\bin'
$clang = Join-Path $toolchain 'clang.exe'
$archiver = Join-Path $toolchain 'llvm-ar.exe'
if (-not (Test-Path -LiteralPath $clang)) { throw "Clang was not found at $clang" }
$targets = @{
    'arm64-v8a' = @('aarch64-linux-android','aarch64-linux-android24')
    'armeabi-v7a' = @('armv7-linux-androideabi','armv7a-linux-androideabi24')
    'x86' = @('i686-linux-android','i686-linux-android24')
    'x86_64' = @('x86_64-linux-android','x86_64-linux-android24')
}
foreach ($abi in $Abis) {
    $rustTarget, $clangTarget = $targets[$abi]
    $targetKey = $rustTarget.Replace('-','_')
    $linkerVariable = 'CARGO_TARGET_' + $targetKey.ToUpperInvariant() + '_LINKER'
    $flagsVariable = 'CARGO_TARGET_' + $targetKey.ToUpperInvariant() + '_RUSTFLAGS'
    $compileVariable = 'CC_' + $targetKey
    $compileFlagsVariable = 'CFLAGS_' + $targetKey
    $archiveVariable = 'AR_' + $targetKey
    $variables = @($linkerVariable,$flagsVariable,$compileVariable,$compileFlagsVariable,$archiveVariable)
    $previous = @{}
    foreach ($variable in $variables) { $previous[$variable] = [Environment]::GetEnvironmentVariable($variable,'Process') }
    try {
        [Environment]::SetEnvironmentVariable($linkerVariable,$clang,'Process')
        [Environment]::SetEnvironmentVariable($flagsVariable,"-C link-arg=--target=$clangTarget -C link-arg=-Wl,-z,max-page-size=16384",'Process')
        [Environment]::SetEnvironmentVariable($compileVariable,$clang,'Process')
        [Environment]::SetEnvironmentVariable($compileFlagsVariable,"--target=$clangTarget",'Process')
        [Environment]::SetEnvironmentVariable($archiveVariable,$archiver,'Process')
        $arguments = @('build','--manifest-path',(Join-Path $workspace 'rust\otium-core\Cargo.toml'),'--locked','--lib','--release','--target',$rustTarget)
        if ($Offline) { $arguments += '--offline' }
        & cargo @arguments
        if ($LASTEXITCODE -ne 0) { throw "Rust Android build failed: $abi" }
        $destination = Join-Path $workspace "android\app\src\main\jniLibs\$abi"
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        Copy-Item -LiteralPath (Join-Path $workspace "rust\otium-core\target\$rustTarget\release\libotium_core.so") -Destination (Join-Path $destination 'libotium_core.so') -Force
        Write-Host "Rust native engine ready: $abi"
    } finally {
        foreach ($variable in $variables) { [Environment]::SetEnvironmentVariable($variable,$previous[$variable],'Process') }
    }
}
