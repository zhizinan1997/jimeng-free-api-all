. (Join-Path $PSScriptRoot 'common.ps1')

$root = Get-PortableRoot $PSScriptRoot
$logs = @(
  (Join-Path $root 'logs\service.stdout.log'),
  (Join-Path $root 'logs\service.stderr.log')
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not $logs) {
  Write-Host 'No logs have been generated yet.'
  exit 0
}

Start-Process notepad.exe -ArgumentList $logs
