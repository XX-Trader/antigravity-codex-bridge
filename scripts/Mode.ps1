#requires -Version 7.0
$ErrorActionPreference='Stop'
& node.exe (Join-Path $PSScriptRoot 'mode.cjs') @args
exit $LASTEXITCODE
