# daemon/tray.ps1 —— Windows 托盘（零依赖：PowerShell NotifyIcon 托管隐藏的 node daemon）
# 用法：
#   双击 daemon\tray.vbs（无窗口启动）；或
#   powershell -NoProfile -ExecutionPolicy Bypass -File daemon\tray.ps1 [-Port 7331]
# 菜单：打开控制台（双击图标同效）/ 状态 / 打开日志 / 重启 daemon / 退出
# 启动时若端口已有 daemon 在跑则「接管显示」（不持有进程，退出只关托盘）；
# 否则拉起隐藏 node 子进程，stdout/stderr 追加到 daemon\.tray.log。
# 测试口（无 GUI）：
#   powershell -File daemon\tray.ps1 -TestSpawn -Port 7377   # 拉起(临时db)→等就绪→打印 TEST OK→杀掉
#   powershell -File daemon\tray.ps1 -SmokeGui 3             # 只初始化托盘 GUI，3 秒后自动退出（不杀已连 daemon）
param(
  [int]$Port = 7331,
  [switch]$TestSpawn,
  [int]$SmokeGui = 0
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $repoRoot 'daemon\.tray.log'
$base = "http://127.0.0.1:$Port"

function Get-Status {
  try { Invoke-RestMethod -Uri "$base/status" -TimeoutSec 2 } catch { $null }
}

function Start-DaemonChild([string]$extraArgs = '') {
  # cmd 包一层做日志重定向；CreateNoWindow 保持无窗口
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/c node daemon/index.mjs serve --port $Port $extraArgs >> `"$logFile`" 2>&1"
  $psi.WorkingDirectory = $repoRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

function Wait-Ready {
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-Status) { return $true }
  }
  return $false
}

function Stop-DaemonChild($proc) {
  if ($proc -and -not $proc.HasExited) {
    & cmd /c taskkill /PID $proc.Id /T /F | Out-Null
  }
}

if ($TestSpawn) {
  if (Get-Status) { Write-Output 'TEST SKIP: port already serving'; exit 0 }
  $tmpDb = 'daemon/.tmp-tray-test.db'
  $proc = Start-DaemonChild "--db $tmpDb"
  $ok = Wait-Ready
  $books = -1
  if ($ok) { $s = Get-Status; $books = @($s.books).Count }
  Stop-DaemonChild $proc
  foreach ($suffix in @('', '-wal', '-shm')) { Remove-Item ($tmpDb + $suffix) -ErrorAction SilentlyContinue }
  if ($ok) { Write-Output "TEST OK: books=$books"; exit 0 }
  Write-Output 'TEST FAIL: daemon not ready in 20s (see daemon\.tray.log)'
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-TrayIcon {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 119, 204))
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font ('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
  $g.DrawString('N', $font, [System.Drawing.Brushes]::White, 8, 3)
  $g.Dispose()
  $font.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $icon
}

$state = @{ Proc = $null; Attached = $false; NotifiedExit = $false }

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-TrayIcon
$notify.Text = "ntr daemon :$Port"
$notify.Visible = $true

function Balloon([string]$title, [string]$text, [System.Windows.Forms.ToolTipIcon]$type = [System.Windows.Forms.ToolTipIcon]::Info) {
  try { $notify.ShowBalloonTip(4000, $title, $text, $type) } catch { }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem ('打开控制台')
$itemOpen.add_Click({ Start-Process "$base/ui" })
[void]$menu.Items.Add($itemOpen)

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem ('状态')
$itemStatus.add_Click({
  try {
    $s = Get-Status
    if (-not $s) { Balloon 'ntr daemon' "端口 $Port 无响应（daemon 未运行）" ([System.Windows.Forms.ToolTipIcon]::Error); return }
    $books = @($s.books).Count
    $progress = 0
    foreach ($b in $s.books) { $progress += [int]$b.progress }
    $rss = ''
    if ($s.metrics -and @($s.metrics).Count -gt 0) { $rss = ' · RSS ' + [math]::Round($s.metrics[-1].rss, 1) + 'MB' }
    $queue = @($s.queue).Count
    Balloon 'ntr daemon 状态' ("书 $books 本 · 已译 $progress 章 · 队列 $queue$rss")
  } catch { Balloon 'ntr daemon' ('状态获取失败：' + $_.Exception.Message) ([System.Windows.Forms.ToolTipIcon]::Error) }
})
[void]$menu.Items.Add($itemStatus)

$itemLog = New-Object System.Windows.Forms.ToolStripMenuItem ('打开日志')
$itemLog.add_Click({
  if (Test-Path $logFile) { Start-Process notepad.exe $logFile }
  else { Balloon 'ntr daemon' '暂无日志（daemon\.tray.log 还没生成）' }
})
[void]$menu.Items.Add($itemLog)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem ('重启 daemon')
$itemRestart.add_Click({
  try {
    if ($state.Attached) { Balloon 'ntr daemon' '托盘启动时 daemon 已在运行（非本托盘拉起），请先退出原进程再由托盘启动'; return }
    Stop-DaemonChild $state.Proc
    $state.Proc = Start-DaemonChild ''
    $state.NotifiedExit = $false
    if (Wait-Ready) { Balloon 'ntr daemon' "daemon 已重启（端口 $Port）" }
    else { Balloon 'ntr daemon' 'daemon 重启失败，详见日志' ([System.Windows.Forms.ToolTipIcon]::Error) }
  } catch { Balloon 'ntr daemon' ('重启失败：' + $_.Exception.Message) ([System.Windows.Forms.ToolTipIcon]::Error) }
})
[void]$menu.Items.Add($itemRestart)

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem ('退出')
$itemExit.add_Click({
  if (-not $state.Attached) { Stop-DaemonChild $state.Proc }
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($itemExit)

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Start-Process "$base/ui" })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($state.Proc -and $state.Proc.HasExited -and -not $state.NotifiedExit) {
    $state.NotifiedExit = $true
    Balloon 'ntr daemon' ('daemon 进程已退出（码 ' + $state.Proc.ExitCode + '）；菜单「重启 daemon」可再拉起，详见日志') ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
$timer.Start()

if (Get-Status) {
  $state.Attached = $true
  Balloon 'ntr daemon' "已连接到运行中的 daemon（端口 $Port）。此托盘未持有进程，退出只关闭托盘。"
} else {
  $state.Proc = Start-DaemonChild ''
  if (Wait-Ready) { Balloon 'ntr daemon' "daemon 已启动（端口 $Port），控制台 http://127.0.0.1:$Port/ui" }
  else { Balloon 'ntr daemon' 'daemon 启动 20s 未就绪，详见 daemon\.tray.log' ([System.Windows.Forms.ToolTipIcon]::Error) }
}

if ($SmokeGui -gt 0) {
  $smoke = New-Object System.Windows.Forms.Timer
  $smoke.Interval = $SmokeGui * 1000
  $smoke.add_Tick({
    $smoke.Stop()
    if (-not $state.Attached) { Stop-DaemonChild $state.Proc }
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })
  $smoke.Start()
}

[System.Windows.Forms.Application]::Run()
