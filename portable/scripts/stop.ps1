$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$root = Get-PortableRoot $PSScriptRoot
$pidFile = Join-Path $root 'run\service.pid'
$node = Join-Path $root 'runtime\node.exe'

try {
  if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'Service is not running.'
    exit 0
  }

  $servicePid = 0
  if (-not [int]::TryParse(
    (Get-Content -Raw -LiteralPath $pidFile).Trim(),
    [ref]$servicePid
  )) {
    throw 'The PID file is invalid. No process was stopped.'
  }

  $owned = Get-OwnedProcess $servicePid $node
  if (-not $owned) {
    throw 'The PID is not owned by this package. No process was stopped.'
  }

  Stop-Process -Id $servicePid -ErrorAction Stop
  Wait-Process -Id $servicePid -Timeout 10 -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host 'Service stopped.'
}
catch {
  Write-Host "Stop failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
