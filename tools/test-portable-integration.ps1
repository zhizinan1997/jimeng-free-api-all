param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Invoke-Launcher([string]$ScriptPath, [switch]$ExpectFailure) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath
  $exitCode = $LASTEXITCODE
  if ($ExpectFailure) {
    if ($exitCode -eq 0) {
      throw "Expected launcher failure: $ScriptPath"
    }
  }
  elseif ($exitCode -ne 0) {
    throw "Launcher failed with exit code $exitCode`: $ScriptPath"
  }
}

function Get-FreePort {
  $listener = New-Object Net.Sockets.TcpListener(
    [Net.IPAddress]::Loopback,
    0
  )
  $listener.Start()
  try {
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Set-PortableSettings(
  [string]$PackagePath,
  [int]$Port,
  [int]$AutoOpenBrowser = 0
) {
  @(
    "PORT=$Port",
    'HOST=127.0.0.1',
    "AUTO_OPEN_BROWSER=$AutoOpenBrowser"
  ) | Set-Content -Encoding UTF8 -LiteralPath (
    Join-Path $PackagePath 'config\portable.env'
  )
}

function Assert-Healthy([int]$Port) {
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -TimeoutSec 5 `
    "http://127.0.0.1:$Port/ping"
  if ($response.Content -notmatch 'pong') {
    throw "Health check failed on port $Port"
  }
}

$ZipPath = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
  throw "ZIP does not exist: $ZipPath"
}

$unicodeName = -join @(
  [char]0x4FBF,
  [char]0x643A,
  [char]0x5305,
  ' ',
  [char]0x6D4B,
  [char]0x8BD5
)
$movedName = -join @(
  [char]0x79FB,
  [char]0x52A8,
  ' ',
  [char]0x540E
)
$testRoot = Join-Path $env:TEMP ('jimeng-portable-' + [guid]::NewGuid())
$package = Join-Path $testRoot $unicodeName
$movedPackage = Join-Path $testRoot $movedName
$activePackage = $package

New-Item -ItemType Directory -Force -Path $package | Out-Null
try {
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $package -Force

  foreach ($required in @(
    'runtime\node.exe',
    'app\dist\index.js',
    'app\public\index.html',
    'scripts\start.ps1',
    'scripts\stop.ps1',
    'config\portable.env'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $required))) {
      throw "Package file is missing: $required"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $package 'app\src')) {
    throw 'Source directory leaked into package.'
  }
  if (Test-Path -LiteralPath (Join-Path $package 'app\node_modules\typescript')) {
    throw 'Development dependency leaked into package.'
  }

  $node = Join-Path $package 'runtime\node.exe'
  Push-Location $package
  try {
    & $node -e "require('./app/node_modules/better-sqlite3')" |
      Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw 'Bundled better-sqlite3 failed to load.'
    }
  }
  finally {
    Pop-Location
  }

  Set-PortableSettings $package 8001
  Invoke-Launcher (Join-Path $package 'scripts\start.ps1')
  Assert-Healthy 8001
  $firstPid = (
    Get-Content -Raw -LiteralPath (Join-Path $package 'run\service.pid')
  ).Trim()
  Invoke-Launcher (Join-Path $package 'scripts\start.ps1')
  $secondPid = (
    Get-Content -Raw -LiteralPath (Join-Path $package 'run\service.pid')
  ).Trim()
  if ($firstPid -ne $secondPid) {
    throw 'Duplicate start changed the service PID.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $package 'data\jimeng.db'))) {
    throw 'Database was not persisted.'
  }
  Invoke-Launcher (Join-Path $package 'scripts\stop.ps1')
  if (Get-Process -Id ([int]$firstPid) -ErrorAction SilentlyContinue) {
    throw 'Owned process did not stop.'
  }

  $customPort = Get-FreePort
  Set-PortableSettings $package $customPort
  Invoke-Launcher (Join-Path $package 'scripts\start.ps1')
  Assert-Healthy $customPort
  Invoke-Launcher (Join-Path $package 'scripts\stop.ps1')

  $conflictListener = New-Object Net.Sockets.TcpListener(
    [Net.IPAddress]::Loopback,
    0
  )
  $conflictListener.Start()
  try {
    $conflictPort = ([Net.IPEndPoint]$conflictListener.LocalEndpoint).Port
    Set-PortableSettings $package $conflictPort
    Invoke-Launcher `
      (Join-Path $package 'scripts\start.ps1') `
      -ExpectFailure
    if (-not $conflictListener.Server.IsBound) {
      throw 'Port-conflict test listener was stopped by the launcher.'
    }
  }
  finally {
    $conflictListener.Stop()
  }

  Move-Item -LiteralPath $package -Destination $movedPackage
  $activePackage = $movedPackage
  $movedPort = Get-FreePort
  Set-PortableSettings $movedPackage $movedPort
  Invoke-Launcher (Join-Path $movedPackage 'scripts\start.ps1')
  Assert-Healthy $movedPort
  Invoke-Launcher (Join-Path $movedPackage 'scripts\stop.ps1')

  Write-Host 'PASS: portable package integration tests'
}
finally {
  if (
    (Test-Path -LiteralPath $activePackage) -and
    (Test-Path -LiteralPath (Join-Path $activePackage 'run\service.pid'))
  ) {
    & powershell.exe `
      -NoProfile `
      -ExecutionPolicy Bypass `
      -File (Join-Path $activePackage 'scripts\stop.ps1') |
      Out-Null
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
