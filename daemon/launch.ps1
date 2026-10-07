# daemon/launch.ps1 —— 一键启动 / 重启 / 停止 / 状态（托盘 + 隐藏 daemon 的包装）
# 用法（双击仓库根 daemon.cmd 等价）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File daemon\launch.ps1 [start|restart|stop|status|console] [-Port N] [-NoBrowser]
#   start   = 端口无 daemon → 拉起托盘（托盘托管隐藏 daemon）、就绪后打开控制台；已在跑 → 只打开控制台
#   restart = 结束该端口的 daemon（按端口定位 + 命令行校验，绝不误伤别的 node）→ 重新拉起 → 打开控制台
#   stop    = 结束该端口的 daemon
#   status  = 打印 /status 摘要（只读，含网络代理状态）
#   console = 只打开控制台
# 端口来源：-Port 显式 > daemon/.serve-port（serve 启动即落盘）> 7331。
param(
  [ValidateSet('start', 'restart', 'stop', 'status', 'console')]
  [string]$Action = 'start',
  [int]$Port = 0,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$daemonDir = $PSScriptRoot

function Get-ServePort {
  if ($Port -ge 1) { return $Port }
  $portFile = Join-Path $daemonDir '.serve-port'
  if (Test-Path $portFile) {
    $candidate = 0
    if ([int]::TryParse((Get-Content $portFile -Raw).Trim(), [ref]$candidate) -and $candidate -ge 1) { return $candidate }
  }
  return 7331
}

function Get-Status([int]$p) {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$p/status" -TimeoutSec 2 } catch { $null }
}

function Get-Ping([int]$p) {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$p/ping" -TimeoutSec 2 } catch { $null }
}

# 按端口定位 daemon 进程：先看谁在 listen，再用命令行确认是本仓库的 index.mjs
function Get-DaemonPid([int]$p) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return 0 }
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $conn.OwningProcess) -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'index\.mjs') { return [int]$conn.OwningProcess }
  } catch { }
  return 0
}

function Wait-Ready([int]$p, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-Status $p) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-Tray([int]$p) {
  Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $daemonDir 'tray.ps1'), '-Port', "$p"
  ) | Out-Null
}

function Open-Console([int]$p) {
  $url = "http://127.0.0.1:$p/ui"
  if ($NoBrowser) { Write-Output "控制台：$url"; return }
  Start-Process $url
}

$port = Get-ServePort
$status = Get-Status $port

switch ($Action) {
  'status' {
    if (-not $status) { Write-Output "daemon 未运行（端口 $port）"; exit 1 }
    $books = @($status.books).Count
    $progress = 0
    foreach ($b in $status.books) { $progress += [int]$b.progress }
    $ping = Get-Ping $port
    $version = if ($ping -and $ping.version) { $ping.version } else { '?' }
    Write-Output "daemon 运行中：端口 $port · 版本 $version · 书 $books 本 · 已译 $progress 章 · 队列 $(@($status.queue).Count)"
    $px = $status.proxy
    if ($px) {
      if ($px.enabled -and $px.url) { Write-Output "网络代理：启用 $($px.url)（直连 $($px.noProxy)）" }
      else { Write-Output '网络代理：未启用（全部直连）' }
    }
    exit 0
  }
  'console' { Open-Console $port; exit 0 }
  'stop' {
    $procId = Get-DaemonPid $port
    if ($procId -eq 0) { Write-Output "端口 $port 上没有 daemon 在跑"; exit 0 }
    & cmd /c taskkill /PID $procId /T /F | Out-Null
    Write-Output "已停止 daemon（端口 $port，PID $procId）"
    exit 0
  }
  'restart' {
    $procId = Get-DaemonPid $port
    if ($procId -ne 0) {
      & cmd /c taskkill /PID $procId /T /F | Out-Null
      Write-Output "已停止旧进程（PID $procId），重新拉起…"
      for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 300; if (-not (Get-Status $port)) { break } }
    }
    Start-Tray $port
    if (Wait-Ready $port) { Write-Output "daemon 已重启并就绪（端口 $port）"; Open-Console $port; exit 0 }
    Write-Output "daemon 30s 未就绪，详见 daemon\.tray-$port.log"
    exit 1
  }
  default {
    if ($status) {
      Write-Output "daemon 已在运行（端口 $port），仅打开控制台（要换代码请用 restart）"
      Open-Console $port
      exit 0
    }
    Start-Tray $port
    if (Wait-Ready $port) { Write-Output "daemon 已启动（端口 $port）"; Open-Console $port; exit 0 }
    Write-Output "daemon 30s 未就绪，详见 daemon\.tray-$port.log"
    exit 1
  }
}
