$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$root = Get-PortableRoot $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
$app = Join-Path $root 'app'
$pidFile = Join-Path $root 'run\service.pid'
$stdout = Join-Path $root 'logs\service.stdout.log'
$stderr = Join-Path $root 'logs\service.stderr.log'

try {
  foreach ($path in @(
    $node,
    (Join-Path $app 'dist\index.js'),
    (Join-Path $app 'package.json')
  )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required file is missing: $path"
    }
  }

  $config = Read-PortableConfig (Join-Path $root 'config\portable.env')
  New-Item -ItemType Directory -Force -Path @(
    (Join-Path $root 'data'),
    (Join-Path $root 'logs'),
    (Join-Path $root 'run'),
    (Join-Path $root 'tmp')
  ) | Out-Null

  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = 0
    [void][int]::TryParse(
      (Get-Content -Raw -LiteralPath $pidFile).Trim(),
      [ref]$oldPid
    )
    if ($oldPid -and (Get-OwnedProcess $oldPid $node)) {
      Write-Host "Service is already running. PID: $oldPid"
      if ($config.AUTO_OPEN_BROWSER) {
        Start-Process "http://localhost:$($config.PORT)"
      }
      exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
  }

  if (Test-TcpPort $config.PORT) {
    throw "Port $($config.PORT) is already in use. Edit config\portable.env."
  }

  $env:NODE_ENV = 'production'
  $env:SERVER_ENV = 'portable'
  $env:SERVER_PORT = [string]$config.PORT
  $env:SERVER_HOST = $config.HOST
  $env:DB_PATH = Join-Path $root 'data\jimeng.db'

  $process = Start-Process `
    -FilePath $node `
    -ArgumentList @('--enable-source-maps', '--no-node-snapshot', 'dist/index.js') `
    -WorkingDirectory $app `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

  $ready = $false
  foreach ($attempt in 1..60) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
      break
    }
    try {
      $response = Invoke-WebRequest `
        -UseBasicParsing `
        -TimeoutSec 2 `
        "http://127.0.0.1:$($config.PORT)/ping"
      if ($response.Content -match 'pong') {
        $ready = $true
        break
      }
    }
    catch {
    }
  }

  if (-not $ready) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $tail = if (Test-Path -LiteralPath $stderr) {
      (Get-Content -LiteralPath $stderr -Tail 20) -join [Environment]::NewLine
    }
    else {
      ''
    }
    throw "Service startup failed. Error log: $stderr`n$tail"
  }

  Write-Host "Service started: http://localhost:$($config.PORT)"
  if ($config.AUTO_OPEN_BROWSER) {
    Start-Process "http://localhost:$($config.PORT)"
  }
}
catch {
  Write-Host "Start failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
