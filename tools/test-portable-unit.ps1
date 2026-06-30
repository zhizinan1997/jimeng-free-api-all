$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'portable\scripts\common.ps1')

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "$Message. Expected [$Expected], got [$Actual]."
  }
}

function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
  try {
    & $Action
    throw "Expected an exception matching [$Pattern]."
  }
  catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw
    }
  }
}

$temp = Join-Path $env:TEMP ('jimeng-unit-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $envFile = Join-Path $temp 'portable.env'
  @('# comment', 'PORT=8123', 'HOST=127.0.0.1', 'AUTO_OPEN_BROWSER=0') |
    Set-Content -Encoding UTF8 $envFile

  $config = Read-PortableConfig $envFile
  Assert-Equal $config.PORT 8123 'PORT parsing failed'
  Assert-Equal $config.HOST '127.0.0.1' 'HOST parsing failed'
  Assert-Equal $config.AUTO_OPEN_BROWSER 0 'AUTO_OPEN_BROWSER parsing failed'

  'PORT=70000' | Set-Content -Encoding UTF8 $envFile
  Assert-Throws { Read-PortableConfig $envFile } 'PORT'

  @('PORT=8001', 'HOST=', 'AUTO_OPEN_BROWSER=1') |
    Set-Content -Encoding UTF8 $envFile
  Assert-Throws { Read-PortableConfig $envFile } 'HOST'

  @('PORT=8001', 'HOST=0.0.0.0', 'AUTO_OPEN_BROWSER=yes') |
    Set-Content -Encoding UTF8 $envFile
  Assert-Throws { Read-PortableConfig $envFile } 'AUTO_OPEN_BROWSER'

  $root = Get-PortableRoot (Join-Path $repo 'portable\scripts')
  Assert-Equal $root (Join-Path $repo 'portable') 'Portable root resolution failed'

  foreach ($relative in @(
    'portable\scripts\start.ps1',
    'portable\scripts\stop.ps1',
    'portable\scripts\view-logs.ps1'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $relative))) {
      throw "Missing launcher: $relative"
    }
  }
  $batchFiles = @(Get-ChildItem -LiteralPath (Join-Path $repo 'portable') -Filter '*.bat' -File)
  Assert-Equal $batchFiles.Count 3 'Expected three batch entry points'

  $defaultConfig = Read-PortableConfig (Join-Path $repo 'portable\config\portable.env')
  Assert-Equal $defaultConfig.PORT 8001 'Default port mismatch'
  Assert-Equal $defaultConfig.HOST '0.0.0.0' 'Default host mismatch'
  Assert-Equal $defaultConfig.AUTO_OPEN_BROWSER 1 'Browser default mismatch'

  $systemConfig = Get-Content -Raw -Encoding UTF8 `
    (Join-Path $repo 'portable\app-config\system.yml')
  foreach ($required in @(
    'logDir: ../logs',
    'tmpDir: ../tmp',
    'publicDir: ./public'
  )) {
    if ($systemConfig -notmatch [regex]::Escape($required)) {
      throw "Missing system config: $required"
    }
  }

  $builderPath = Join-Path $repo 'tools\build-portable.ps1'
  if (-not (Test-Path -LiteralPath $builderPath -PathType Leaf)) {
    throw 'Missing portable package builder'
  }
  $builder = Get-Content -Raw -Encoding UTF8 $builderPath
  foreach ($required in @(
    'v20.19.5',
    'c48159529572a5a947eef2d55d6485dfdc4ce8e67216402e2f6de52ad5d95695',
    'npm.cmd',
    'ci',
    'run',
    'build',
    '--omit=dev',
    'better-sqlite3'
  )) {
    if ($builder -notmatch [regex]::Escape($required)) {
      throw "Missing builder contract: $required"
    }
  }

  Write-Host 'PASS: portable launcher unit tests'
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
