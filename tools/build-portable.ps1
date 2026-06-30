param(
  [string]$OutputDirectory = '',
  [string]$BuildDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repo 'outputs'
}
if (-not $BuildDirectory) {
  $BuildDirectory = Join-Path $repo 'work\portable-build'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)

function Assert-ChildPath([string]$Parent, [string]$Child) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe path outside expected parent: $Child"
  }
}

function Invoke-External([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
  }
  finally {
    Pop-Location
  }
}

Assert-ChildPath $repo $BuildDirectory
$stage = Join-Path $BuildDirectory 'package'
$source = Join-Path $BuildDirectory 'source'
$downloads = Join-Path $BuildDirectory 'downloads'
$extract = Join-Path $BuildDirectory 'node-extract'

if (Test-Path -LiteralPath $BuildDirectory) {
  Remove-Item -LiteralPath $BuildDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path @(
  $BuildDirectory,
  $stage,
  $source,
  $downloads,
  $extract,
  $OutputDirectory
) | Out-Null

$nodeVersion = 'v20.19.5'
$nodeArchiveName = "node-$nodeVersion-win-x64.zip"
$nodeBaseUrl = "https://nodejs.org/dist/$nodeVersion"
$nodeArchive = Join-Path $downloads $nodeArchiveName
$checksumFile = Join-Path $downloads 'SHASUMS256.txt'
$expectedSha256 = 'c48159529572a5a947eef2d55d6485dfdc4ce8e67216402e2f6de52ad5d95695'
$sqliteArchiveName = 'better-sqlite3-v11.10.0-node-v115-win32-x64.tar.gz'
$sqliteArchiveUrl = "https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/$sqliteArchiveName"
$sqliteArchive = Join-Path $downloads $sqliteArchiveName
$sqliteSha256 = '090c06c7e3b003e5cf99cbd280b62d13a5fc9a80f7a5836f1ea3485e3cf85890'

Write-Host "Downloading Node.js $nodeVersion..."
Invoke-WebRequest -UseBasicParsing "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchive
Invoke-WebRequest -UseBasicParsing "$nodeBaseUrl/SHASUMS256.txt" -OutFile $checksumFile
Invoke-WebRequest -UseBasicParsing $sqliteArchiveUrl -OutFile $sqliteArchive

$manifestLine = Get-Content -LiteralPath $checksumFile |
  Where-Object { $_ -match [regex]::Escape($nodeArchiveName) } |
  Select-Object -First 1
if (-not $manifestLine) {
  throw "Node.js checksum manifest does not contain $nodeArchiveName"
}
$manifestSha256 = ($manifestLine -split '\s+')[0].ToLowerInvariant()
if ($manifestSha256 -ne $expectedSha256) {
  throw "Pinned Node.js checksum does not match the official manifest."
}
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "Downloaded Node.js archive checksum mismatch."
}
$actualSqliteSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sqliteArchive).Hash.ToLowerInvariant()
if ($actualSqliteSha256 -ne $sqliteSha256) {
  throw "Downloaded better-sqlite3 archive checksum mismatch."
}

Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extract -Force
$nodeHome = Join-Path $extract "node-$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeHome 'node.exe'
$npmCmd = Join-Path $nodeHome 'npm.cmd'
$env:PATH = "$nodeHome;$env:PATH"

Write-Host 'Preparing isolated source tree...'
$excludedTopLevel = @('.git', '.worktrees', 'node_modules', 'dist', 'outputs', 'work')
foreach ($item in Get-ChildItem -LiteralPath $repo -Force) {
  if ($item.Name -notin $excludedTopLevel) {
    Copy-Item -LiteralPath $item.FullName -Destination $source -Recurse -Force
  }
}

Write-Host 'Installing build dependencies...'
Invoke-External $npmCmd @('ci', '--ignore-scripts', '--no-audit', '--no-fund') $source
Invoke-External $npmCmd @('run', 'build') $source

Write-Host 'Assembling portable package...'
Copy-Item -Path (Join-Path $repo 'portable\*') -Destination $stage -Recurse -Force
New-Item -ItemType Directory -Force -Path @(
  (Join-Path $stage 'runtime'),
  (Join-Path $stage 'app'),
  (Join-Path $stage 'app\configs\portable'),
  (Join-Path $stage 'data'),
  (Join-Path $stage 'logs'),
  (Join-Path $stage 'run'),
  (Join-Path $stage 'tmp')
) | Out-Null

Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stage 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $nodeHome 'LICENSE') -Destination (Join-Path $stage 'runtime\NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination (Join-Path $stage 'app\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $source 'public') -Destination (Join-Path $stage 'app\public') -Recurse
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination (Join-Path $stage 'app\package.json')
Copy-Item -LiteralPath (Join-Path $source 'package-lock.json') -Destination (Join-Path $stage 'app\package-lock.json')
Copy-Item -Path (Join-Path $repo 'portable\app-config\*') `
  -Destination (Join-Path $stage 'app\configs\portable') -Recurse -Force
Remove-Item -LiteralPath (Join-Path $stage 'app-config') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $stage 'LICENSE')
Copy-Item -LiteralPath (Join-Path $repo 'README.md') -Destination (Join-Path $stage 'README.md')

Write-Host 'Installing production dependencies...'
Invoke-External $npmCmd @(
  'ci',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund'
) (Join-Path $stage 'app')

$sqliteModule = Join-Path $stage 'app\node_modules\better-sqlite3'
Invoke-External 'tar.exe' @('-xzf', $sqliteArchive, '-C', $sqliteModule) $stage

$nativeCheck = @"
const Database = require('./app/node_modules/better-sqlite3');
const db = new Database(':memory:');
db.exec('select 1');
db.close();
console.log('better-sqlite3 OK');
"@
Invoke-External $nodeExe @('-e', $nativeCheck) $stage

Remove-Item -LiteralPath (Join-Path $stage 'app\package-lock.json') -Force
$upstreamCommit = (git -C $repo rev-parse HEAD).Trim()
$packageJson = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo 'package.json') |
  ConvertFrom-Json
@(
  'Jimeng Free API Windows Portable Package'
  "Upstream commit: $upstreamCommit"
  "Application version: $($packageJson.version)"
  "Node.js version: $nodeVersion"
  "Build time UTC: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
) | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'VERSION.txt')

$zipPath = Join-Path $OutputDirectory 'jimeng-free-api-windows-x64-portable.zip'
$shaPath = "$zipPath.sha256.txt"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $shaPath) {
  Remove-Item -LiteralPath $shaPath -Force
}

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
"$zipHash  $(Split-Path $zipPath -Leaf)" |
  Set-Content -Encoding ASCII -LiteralPath $shaPath

Write-Host "Portable package: $zipPath"
Write-Host "SHA256: $zipHash"
