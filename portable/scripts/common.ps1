Set-StrictMode -Version 2

function Get-PortableRoot([string]$ScriptsDirectory) {
  return [IO.Path]::GetFullPath((Join-Path $ScriptsDirectory '..')).TrimEnd('\')
}

function Read-PortableConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Configuration file does not exist: $Path"
  }

  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim().TrimStart([char]0xFEFF)
    if (-not $line -or $line.StartsWith('#')) {
      continue
    }

    $parts = $line.Split('=', 2)
    if ($parts.Count -ne 2) {
      throw "Invalid configuration line: $rawLine"
    }
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }

  $port = 0
  if (
    -not [int]::TryParse([string]($values['PORT']), [ref]$port) -or
    $port -lt 1 -or
    $port -gt 65535
  ) {
    throw 'PORT must be an integer from 1 to 65535.'
  }

  if ([string]::IsNullOrWhiteSpace([string]($values['HOST']))) {
    throw 'HOST must not be empty.'
  }

  $autoOpen = 0
  if (
    -not [int]::TryParse([string]($values['AUTO_OPEN_BROWSER']), [ref]$autoOpen) -or
    $autoOpen -notin @(0, 1)
  ) {
    throw 'AUTO_OPEN_BROWSER must be 0 or 1.'
  }

  return @{
    PORT = $port
    HOST = [string]($values['HOST'])
    AUTO_OPEN_BROWSER = $autoOpen
  }
}

function Test-TcpPort([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    return $async.AsyncWaitHandle.WaitOne(250) -and $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Close()
  }
}

function Get-OwnedProcess([int]$ProcessId, [string]$NodePath) {
  $process = Get-CimInstance Win32_Process `
    -Filter "ProcessId = $ProcessId" `
    -ErrorAction SilentlyContinue
  if (-not $process) {
    return $null
  }

  $expectedNode = [IO.Path]::GetFullPath($NodePath)
  $actualNode = if ($process.ExecutablePath) {
    [IO.Path]::GetFullPath($process.ExecutablePath)
  }
  else {
    ''
  }

  if ($actualNode -ne $expectedNode) {
    return $null
  }
  if (
    $process.CommandLine -notlike '*dist/index.js*' -and
    $process.CommandLine -notlike '*dist\index.js*'
  ) {
    return $null
  }

  return $process
}
