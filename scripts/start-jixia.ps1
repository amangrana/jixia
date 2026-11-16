# Starts jixia if it is not already running, then opens it in its own window.
# The desktop shortcut runs this. 稷下 runs in a minimized window titled
# "稷下"; it closes by itself when you press 退出 in the app, and stays open
# after an error so the message can be read.
#   -NoBrowser   start (or find) jixia without opening a window, for checking
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Same port as the app: config.yaml if it sets one, otherwise the default.
$port = 4517
$config = Join-Path $root 'config.yaml'
if (Test-Path $config) {
  $line = Select-String -Path $config -Pattern '^\s*port:\s*(\d+)' | Select-Object -First 1
  if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}
$url = "http://127.0.0.1:$port"

function Test-Running {
  try { Invoke-RestMethod "$url/api/status" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

function Show-Error([string]$text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, '稷下', 'OK', 'Error') | Out-Null
}

if (-not (Test-Running)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Show-Error '找不到 node。请确认 Node.js 已安装，并且在 PATH 里。'; exit 1 }

  # Build the web page when it never was, or when its source changed since.
  $built = Join-Path $root 'web\dist\index.html'
  $stale = -not (Test-Path $built)
  if (-not $stale) {
    $builtAt = (Get-Item $built).LastWriteTime
    $stale = [bool](Get-ChildItem (Join-Path $root 'web') -Recurse -File -Exclude 'dist' | Where-Object { $_.FullName -notlike '*\web\dist\*' -and $_.LastWriteTime -gt $builtAt } | Select-Object -First 1)
  }
  if ($stale) {
    Push-Location $root
    try { & npm.cmd run build | Out-Null } finally { Pop-Location }
  }

  # The window closes when 稷下 ends normally (退出 in the app) and pauses when it ends with an error.
  $server = Start-Process cmd.exe -ArgumentList '/c', "title 稷下 && `"$node`" src\main.ts || pause" -WorkingDirectory $root -WindowStyle Minimized -PassThru

  # Startup checks both CLIs' logins and model lists first; that takes a few seconds.
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Running)) {
    if ($server.HasExited -or (Get-Date) -gt $deadline) {
      Show-Error "稷下没有启动起来。打开任务栏里标题为“稷下”的窗口查看原因。"
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}

if ($NoBrowser) { Write-Output "jixia is running at $url"; exit 0 }

# A browser in app mode: its own window, without tabs or an address bar.
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($browser) { Start-Process $browser -ArgumentList "--app=$url" }
else { Start-Process $url }
