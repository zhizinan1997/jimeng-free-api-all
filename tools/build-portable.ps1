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

function Invoke-Download([string]$Url, [string]$OutFile) {
  $attempts = 3
  for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing $Url -OutFile $OutFile
      return
    }
    catch {
      if ($attempt -eq $attempts) {
        throw
      }
      Write-Host "Download failed, retrying ($attempt/$attempts): $Url"
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
}

Assert-ChildPath $repo $BuildDirectory
Assert-ChildPath $repo $OutputDirectory
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

$nodeVersion = 'v22.23.2'
$nodeArchiveName = "node-$nodeVersion-win-x64.zip"
$nodeBaseUrl = "https://nodejs.org/dist/$nodeVersion"
$nodeArchive = Join-Path $downloads $nodeArchiveName
$checksumFile = Join-Path $downloads 'SHASUMS256.txt'
$expectedSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'

Write-Host "Downloading Node.js $nodeVersion..."
Invoke-Download "$nodeBaseUrl/$nodeArchiveName" $nodeArchive
Invoke-Download "$nodeBaseUrl/SHASUMS256.txt" $checksumFile

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
