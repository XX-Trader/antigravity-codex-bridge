#requires -Version 7.0
$ErrorActionPreference='Stop'
& node.exe (Join-Path $PSScriptRoot 'setup.cjs') @args
exit $LASTEXITCODE
