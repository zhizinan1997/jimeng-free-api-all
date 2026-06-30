# Jimeng Free API Windows Portable Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a Windows 10/11 x64 ZIP that runs Jimeng Free API by double-click without requiring Node.js, npm, or Docker on the target PC.

**Architecture:** A deterministic PowerShell build script downloads a pinned official Node.js 20 x64 runtime, builds the upstream TypeScript project, installs only production dependencies into a staging tree, and creates the ZIP. Thin UTF-8 batch entry points invoke PowerShell launchers; shared functions validate configuration and process ownership, while start/stop scripts manage only the bundled Node process through an owned PID file.

**Tech Stack:** Node.js 20.19.5 x64, npm lockfile installs, TypeScript/tsup, PowerShell 5.1, Windows batch files, `Compress-Archive`, HTTP `/ping` integration checks.

---

## File Map

- `portable/scripts/common.ps1`: configuration parsing, TCP checks, PID ownership validation, and path helpers shared by launchers and tests.
- `portable/scripts/start.ps1`: validate, start, health-check, record PID, and optionally open the browser.
- `portable/scripts/stop.ps1`: stop only the verified package-owned process and remove the PID file.
- `portable/scripts/view-logs.ps1`: open the two launcher log files.
- `portable/启动服务.bat`, `portable/停止服务.bat`, `portable/查看日志.bat`: double-click entry points.
- `portable/config/portable.env`: user-facing defaults.
- `portable/app-config/service.yml`, `portable/app-config/system.yml`: the application’s `portable` environment templates.
- `portable/使用说明.txt`: Chinese operating and troubleshooting guide.
- `tools/build-portable.ps1`: deterministic staging, dependency verification, manifest creation, and ZIP packaging.
- `tools/test-portable-unit.ps1`: dependency-free tests for shared launcher logic.
- `tools/test-portable-integration.ps1`: extracted-package startup, duplicate-start, persistence, port-conflict, relocation, and stop tests.

### Task 1: Shared Launcher Functions

**Files:**
- Create: `portable/scripts/common.ps1`
- Create: `tools/test-portable-unit.ps1`

- [ ] **Step 1: Write failing dependency-free unit tests**

Create `tools/test-portable-unit.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'portable\scripts\common.ps1')

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message. Expected [$Expected], got [$Actual]." }
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
  try { & $Action; throw "Expected an exception matching [$Pattern]." }
  catch { if ($_.Exception.Message -notmatch $Pattern) { throw } }
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
  @('PORT=8001', 'HOST=', 'AUTO_OPEN_BROWSER=1') | Set-Content -Encoding UTF8 $envFile
  Assert-Throws { Read-PortableConfig $envFile } 'HOST'
  @('PORT=8001', 'HOST=0.0.0.0', 'AUTO_OPEN_BROWSER=yes') | Set-Content -Encoding UTF8 $envFile
  Assert-Throws { Read-PortableConfig $envFile } 'AUTO_OPEN_BROWSER'

  $root = Get-PortableRoot (Join-Path $repo 'portable\scripts')
  Assert-Equal $root (Join-Path $repo 'portable') 'Portable root resolution failed'
  Write-Host 'PASS: portable launcher unit tests'
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Run tests and verify the missing-file failure**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-portable-unit.ps1
```

Expected: FAIL because `portable\scripts\common.ps1` does not exist.

- [ ] **Step 3: Implement the shared functions**

Create `portable/scripts/common.ps1`:

```powershell
Set-StrictMode -Version 2

function Get-PortableRoot([string]$ScriptsDirectory) {
  return [IO.Path]::GetFullPath((Join-Path $ScriptsDirectory '..'))
}

function Read-PortableConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "配置文件不存在：$Path"
  }
  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim().TrimStart([char]0xFEFF)
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line.Split('=', 2)
    if ($parts.Count -ne 2) { throw "配置行格式错误：$rawLine" }
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }
  $port = 0
  if (-not [int]::TryParse($values['PORT'], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'PORT 必须是 1 到 65535 的整数。'
  }
  if ([string]::IsNullOrWhiteSpace($values['HOST'])) { throw 'HOST 不能为空。' }
  $autoOpen = 0
  if (-not [int]::TryParse($values['AUTO_OPEN_BROWSER'], [ref]$autoOpen) -or $autoOpen -notin 0, 1) {
    throw 'AUTO_OPEN_BROWSER 只能是 0 或 1。'
  }
  return @{ PORT = $port; HOST = $values['HOST']; AUTO_OPEN_BROWSER = $autoOpen }
}

function Test-TcpPort([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    return $async.AsyncWaitHandle.WaitOne(250) -and $client.Connected
  } catch { return $false }
  finally { $client.Close() }
}

function Get-OwnedProcess([int]$ProcessId, [string]$NodePath, [string]$AppPath) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $expectedNode = [IO.Path]::GetFullPath($NodePath)
  $actualNode = if ($process.ExecutablePath) { [IO.Path]::GetFullPath($process.ExecutablePath) } else { '' }
  if ($actualNode -ne $expectedNode) { return $null }
  if ($process.CommandLine -notlike "*dist/index.js*" -and $process.CommandLine -notlike "*dist\index.js*") { return $null }
  if ([IO.Path]::GetFullPath($AppPath) -ne [IO.Path]::GetFullPath((Split-Path $expectedNode -Parent | Split-Path -Parent) + '\app')) {
    return $null
  }
  return $process
}
```

- [ ] **Step 4: Run unit tests**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-portable-unit.ps1
```

Expected: `PASS: portable launcher unit tests`.

- [ ] **Step 5: Commit**

```powershell
git add portable/scripts/common.ps1 tools/test-portable-unit.ps1
git commit -m "test: add portable launcher primitives"
```

### Task 2: Start, Stop, and Log Launchers

**Files:**
- Create: `portable/scripts/start.ps1`
- Create: `portable/scripts/stop.ps1`
- Create: `portable/scripts/view-logs.ps1`
- Create: `portable/启动服务.bat`
- Create: `portable/停止服务.bat`
- Create: `portable/查看日志.bat`

- [ ] **Step 1: Extend unit tests with static launcher contracts**

Append before the PASS line in `tools/test-portable-unit.ps1`:

```powershell
foreach ($relative in @(
  'portable\scripts\start.ps1', 'portable\scripts\stop.ps1',
  'portable\scripts\view-logs.ps1', 'portable\启动服务.bat',
  'portable\停止服务.bat', 'portable\查看日志.bat'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $repo $relative))) { throw "Missing launcher: $relative" }
}
```

- [ ] **Step 2: Run tests and verify they fail on missing launchers**

Run the Task 1 unit-test command.

Expected: FAIL containing `Missing launcher`.

- [ ] **Step 3: Implement `start.ps1`**

Create `portable/scripts/start.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-PortableRoot $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
$app = Join-Path $root 'app'
$pidFile = Join-Path $root 'run\service.pid'
$stdout = Join-Path $root 'logs\service.stdout.log'
$stderr = Join-Path $root 'logs\service.stderr.log'

try {
  foreach ($path in @($node, (Join-Path $app 'dist\index.js'), (Join-Path $app 'package.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "必要文件缺失：$path" }
  }
  $config = Read-PortableConfig (Join-Path $root 'config\portable.env')
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'data'), (Join-Path $root 'logs'), (Join-Path $root 'run') | Out-Null

  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$oldPid)
    if ($oldPid -and (Get-OwnedProcess $oldPid $node $app)) {
      Write-Host "服务已经运行，PID：$oldPid"
      if ($config.AUTO_OPEN_BROWSER) { Start-Process "http://localhost:$($config.PORT)" }
      exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
  }
  if (Test-TcpPort $config.PORT) { throw "端口 $($config.PORT) 已被占用，请修改 config\portable.env。" }

  $env:NODE_ENV = 'production'
  $env:SERVER_ENV = 'portable'
  $env:SERVER_PORT = [string]$config.PORT
  $env:SERVER_HOST = $config.HOST
  $env:DB_PATH = Join-Path $root 'data\jimeng.db'
  $process = Start-Process -FilePath $node `
    -ArgumentList @('--enable-source-maps', '--no-node-snapshot', 'dist/index.js') `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

  $ready = $false
  foreach ($attempt in 1..60) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    try {
      if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$($config.PORT)/ping").Content -match 'pong') {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $tail = if (Test-Path $stderr) { (Get-Content -LiteralPath $stderr -Tail 20) -join [Environment]::NewLine } else { '' }
    throw "服务启动失败。错误日志：$stderr`n$tail"
  }
  Write-Host "服务启动成功：http://localhost:$($config.PORT)"
  if ($config.AUTO_OPEN_BROWSER) { Start-Process "http://localhost:$($config.PORT)" }
}
catch {
  Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
```

- [ ] **Step 4: Implement stop and log launchers**

Create `portable/scripts/stop.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-PortableRoot $PSScriptRoot
$pidFile = Join-Path $root 'run\service.pid'
try {
  if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host '服务未运行。'; exit 0 }
  $servicePid = 0
  if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$servicePid)) {
    throw 'PID 文件无效，未结束任何进程。'
  }
  $owned = Get-OwnedProcess $servicePid (Join-Path $root 'runtime\node.exe') (Join-Path $root 'app')
  if (-not $owned) { throw '无法确认该 PID 属于本便携包，未结束任何进程。' }
  Stop-Process -Id $servicePid -ErrorAction Stop
  Wait-Process -Id $servicePid -Timeout 10 -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host '服务已停止。'
} catch { Write-Host "停止失败：$($_.Exception.Message)" -ForegroundColor Red; exit 1 }
```

Create `portable/scripts/view-logs.ps1`:

```powershell
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-PortableRoot $PSScriptRoot
$logs = @(
  (Join-Path $root 'logs\service.stdout.log'),
  (Join-Path $root 'logs\service.stderr.log')
) | Where-Object { Test-Path -LiteralPath $_ }
if (-not $logs) { Write-Host '尚未生成日志。'; exit 0 }
Start-Process notepad.exe -ArgumentList $logs
```

- [ ] **Step 5: Implement the three UTF-8 batch entry points**

Each file uses the matching script name:

```batch
@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
if errorlevel 1 pause
```

Use `stop.ps1` for `停止服务.bat` and `view-logs.ps1` for `查看日志.bat`.

- [ ] **Step 6: Run unit tests and commit**

Run the Task 1 test command; expect PASS.

```powershell
git add portable tools/test-portable-unit.ps1
git commit -m "feat: add Windows portable launchers"
```

### Task 3: Portable Configuration and Documentation

**Files:**
- Create: `portable/config/portable.env`
- Create: `portable/app-config/service.yml`
- Create: `portable/app-config/system.yml`
- Create: `portable/使用说明.txt`

- [ ] **Step 1: Add configuration contract checks**

Append before the PASS line in `tools/test-portable-unit.ps1`:

```powershell
$defaultConfig = Read-PortableConfig (Join-Path $repo 'portable\config\portable.env')
Assert-Equal $defaultConfig.PORT 8001 'Default port mismatch'
Assert-Equal $defaultConfig.HOST '0.0.0.0' 'Default host mismatch'
Assert-Equal $defaultConfig.AUTO_OPEN_BROWSER 1 'Browser default mismatch'
$systemConfig = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'portable\app-config\system.yml')
foreach ($required in @('logDir: ../logs', 'tmpDir: ../tmp', 'publicDir: ./public')) {
  if ($systemConfig -notmatch [regex]::Escape($required)) { throw "Missing system config: $required" }
}
```

- [ ] **Step 2: Verify the contract tests fail**

Run the unit tests; expect FAIL because the files do not exist.

- [ ] **Step 3: Add exact configuration files**

`portable/config/portable.env`:

```text
PORT=8001
HOST=0.0.0.0
AUTO_OPEN_BROWSER=1
```

`portable/app-config/service.yml`:

```yaml
name: jimeng-free-api
host: '0.0.0.0'
port: 8001
```

`portable/app-config/system.yml`:

```yaml
requestLog: true
tmpDir: ../tmp
logDir: ../logs
logWriteInterval: 200
logFileExpires: 2626560000
publicDir: ./public
tmpFileExpires: 86400000
```

- [ ] **Step 4: Write the Chinese usage guide**

Document: supported OS, double-click start/stop, default URL, first-time admin setup, `portable.env` fields, Session ID configuration through API clients, persistent folders, update backup procedure, port-conflict remedy, logs, and the upstream non-commercial/reverse-API disclaimer.

- [ ] **Step 5: Run tests and commit**

Run unit tests; expect PASS.

```powershell
git add portable tools/test-portable-unit.ps1
git commit -m "docs: add portable configuration and guide"
```

### Task 4: Deterministic Package Builder

**Files:**
- Create: `tools/build-portable.ps1`

- [ ] **Step 1: Add a build-script contract test**

The unit test must assert that `tools/build-portable.ps1` contains the pinned strings `v20.19.5`, SHA-256 `c48159529572a5a947eef2d55d6485dfdc4ce8e67216402e2f6de52ad5d95695`, `npm.cmd ci`, `npm.cmd run build`, `--omit=dev`, and `better-sqlite3`.

- [ ] **Step 2: Verify the contract test fails**

Run unit tests; expect FAIL because the builder is missing.

- [ ] **Step 3: Implement the package builder**

The script must:

1. Create `work\portable-build` and `outputs` after resolving and checking both paths stay below the workspace root.
2. Download `node-v20.19.5-win-x64.zip` and official `SHASUMS256.txt` from `https://nodejs.org/dist/v20.19.5/`.
3. Parse the official checksum line and verify `Get-FileHash -Algorithm SHA256`; abort on mismatch.
4. Extract Node.js and copy the runtime to staging.
5. Prepend staged runtime to `PATH`; run `runtime\npm.cmd ci` and `runtime\npm.cmd run build` in the repository.
6. Copy `dist`, `public`, `package.json`, `package-lock.json`, portable launchers/config, `LICENSE`, and `README.md` into staging.
7. Copy `portable\app-config` to `app\configs\portable`.
8. Run staged `npm.cmd ci --omit=dev --ignore-scripts=false` in `app`.
9. Verify with `runtime\node.exe -e "const D=require('./app/node_modules/better-sqlite3'); const d=new D(':memory:'); d.exec('select 1'); d.close()"`.
10. Remove runtime npm tooling, caches, and staging-only package metadata that are not needed to execute `node.exe`.
11. Generate `版本信息.txt` containing upstream commit, package version, Node version, build time, and SHA-256 of the final ZIP.
12. Create `outputs\jimeng-free-api-windows-x64-portable.zip`.

- [ ] **Step 4: Run unit tests, run the builder, and inspect the ZIP**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-portable-unit.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\build-portable.ps1
```

Expected: unit PASS; build exit 0; ZIP exists; native module check prints no error.

- [ ] **Step 5: Commit**

```powershell
git add tools/build-portable.ps1 tools/test-portable-unit.ps1
git commit -m "build: create Windows portable ZIP"
```

### Task 5: End-to-End Package Verification

**Files:**
- Create: `tools/test-portable-integration.ps1`

- [ ] **Step 1: Write the integration test**

The script accepts `-ZipPath`, extracts to an isolated directory named `便携包 测试`（同时覆盖中文和空格路径）, sets `AUTO_OPEN_BROWSER=0`, and performs:

```powershell
& "$package\scripts\start.ps1"
if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8001/ping").Content -notmatch 'pong') { throw 'Health check failed' }
$firstPid = Get-Content "$package\run\service.pid"
& "$package\scripts\start.ps1"
if ((Get-Content "$package\run\service.pid") -ne $firstPid) { throw 'Duplicate process was started' }
if (-not (Test-Path "$package\data\jimeng.db")) { throw 'Database was not persisted' }
& "$package\scripts\stop.ps1"
if (Get-Process -Id $firstPid -ErrorAction SilentlyContinue) { throw 'Owned process did not stop' }
```

It then changes the port to an available ephemeral port and repeats start/ping/stop; starts a temporary `TcpListener` and asserts startup fails without stopping the listener; finally repeats the normal test after moving the extracted package to another Chinese-and-space path. A `finally` block always invokes `stop.ps1` and removes the temporary tree.

- [ ] **Step 2: Run it against the ZIP**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-portable-integration.ps1 `
  -ZipPath ..\..\outputs\jimeng-free-api-windows-x64-portable.zip
```

Expected: `PASS: portable package integration tests`.

- [ ] **Step 3: Verify package contents and production-only dependencies**

Extract once and assert:

```powershell
if (Test-Path "$package\app\src") { throw 'Source directory leaked into package' }
if (Test-Path "$package\app\node_modules\typescript") { throw 'Dev dependency leaked into package' }
& "$package\runtime\node.exe" -e "require('./app/node_modules/better-sqlite3')"
```

Expected: exit 0.

- [ ] **Step 4: Run final repository and artifact checks**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-portable-unit.ps1
npm.cmd run build
git diff --check
Get-FileHash -Algorithm SHA256 ..\..\outputs\jimeng-free-api-windows-x64-portable.zip
```

Expected: tests PASS, build exit 0, no whitespace errors, and a SHA-256 value.

- [ ] **Step 5: Commit the test and record final status**

```powershell
git add tools/test-portable-integration.ps1
git commit -m "test: verify Windows portable package end to end"
git status --short --branch
```

Expected: clean worktree, local branch ahead only by intentional packaging commits.
