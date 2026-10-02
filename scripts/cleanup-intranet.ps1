#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Check')][string]$CheckDirectory,
    [Parameter(Mandatory, ParameterSetName = 'Build')][switch]$BuildCache,
    [string]$TempRoot = [IO.Path]::GetTempPath()
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\', '/')
$path = if ($BuildCache) {
    Join-Path $root 'rustpad-intranet-build'
} else {
    [IO.Path]::GetFullPath($CheckDirectory).TrimEnd('\', '/')
}
$name = [IO.Path]::GetFileName($path)
if ([IO.Path]::GetDirectoryName($path) -ne $root -or
    (-not $BuildCache -and $name -notmatch '^rustpad-intranet-check\.[A-Za-z0-9]{8}$')) {
    throw "Refusing cleanup outside the Rustpad temporary directory: $path"
}
if (-not (Test-Path -LiteralPath $path)) { return }

$lock = $null
$lockStream = $null
try {
# Reject links before any recursive removal, including links in ancestor paths.
$ancestor = $path
while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing cleanup through a reparse point: $ancestor"
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
if ($BuildCache) {
    $candidateLock = Join-Path $root 'rustpad-intranet-build.lock'
    $lockStream = [IO.File]::Open($candidateLock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $lock = $candidateLock
}
$pending = New-Object System.Collections.Generic.Stack[string]
$pending.Push($path)
while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing cleanup with a reparse point: $($item.FullName)"
        }
        if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
}
$busy = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) -or
    ($BuildCache -and $_.Name -match '^(cargo|rustc|link)\.exe$')
})
if ($busy.Count) { throw "Refusing cleanup while an executable or compiler is active: $path" }

Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
if (Test-Path -LiteralPath $path) { throw "Cleanup did not remove the directory: $path" }
Write-Host "Removed Rustpad temporary directory: $path"
} finally {
    if ($lockStream) { $lockStream.Dispose() }
    if ($lock) { [IO.File]::Delete($lock) }
}
