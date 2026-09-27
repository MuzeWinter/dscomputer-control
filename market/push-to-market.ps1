<#
  push-to-market.ps1 —— 把本仓库推到 GitHub，并向插件市场（awesome-dsh-plugin）提交收录 PR。

  前置（一次性）：
      gh auth login            # 交互式登录 GitHub（浏览器授权）

  用法：
      # 只建/推仓库 + 打 topic（并把 package.json 里的 owner 改成真实用户名）
      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -RepoOnly

      # 仓库创建满 24 小时后再提 PR（市场 CI 会校验仓库年龄）
      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -PrOnly

      # 一次做完（仓库刚建时 CI 会因"未满 1 天"标红，24h 后重跑 -PrOnly 即可）
      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1

      # 预演：只打印将要执行的命令
      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Owner = '',
  [string]$RepoName = 'dscomputer-control',
  [string]$MarketRepo = 'awesome-dsh-plugin/awesome-dsh-plugin',
  [string]$Description = 'Windows desktop automation for DeepSeek Harness: 14 tools for real GUI input (click, type, keys, scroll, drag), occlusion-proof window screenshots and the accessibility tree.',
  [switch]$RepoOnly,
  [switch]$PrOnly,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$marketDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $marketDir
$entryTemplate = Join-Path $marketDir 'entry.yml'

function Say($m) { Write-Host $m }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }
function Run([string]$cmd, [string[]]$cmdArgs) {
  if ($DryRun) { Write-Host "  > $cmd $($cmdArgs -join ' ')" -ForegroundColor DarkGray; return }
  & $cmd @cmdArgs
  if ($LASTEXITCODE -ne 0) { Die "命令失败（退出码 $LASTEXITCODE）：$cmd $($cmdArgs -join ' ')" }
}
function Gh([string[]]$cmdArgs) {
  if ($DryRun) { Write-Host "  > gh $($cmdArgs -join ' ')" -ForegroundColor DarkGray; return }
  $out = & gh @cmdArgs
  if ($LASTEXITCODE -ne 0) { Die "gh 失败（退出码 $LASTEXITCODE）：gh $($cmdArgs -join ' ')" }
  return $out
}

Say "=== DScomputer-control → 插件市场 ==="
Say "仓库目录 : $repoRoot"
Say "市场仓库 : $MarketRepo"
Say "模式     : $(if ($DryRun) { 'DRY-RUN（只打印）' } elseif ($PrOnly) { '只提 PR' } elseif ($RepoOnly) { '只建/推仓库' } else { '全流程' })"

# ---------- 0) 认证 ----------
if (-not $DryRun) {
  $auth = & gh auth status 2>&1
  if ($LASTEXITCODE -ne 0) {
    Die @"
GitHub CLI 未登录。请先执行一次（浏览器授权，约 30 秒）：
        gh auth login
    授权完成后重新运行本脚本即可。
"@
  }
  if (-not $Owner) {
    $Owner = (& gh api user -q .login).Trim()
    if (-not $Owner) { Die "无法从 gh 获取用户名，请用 -Owner <你的GitHub用户名> 指定" }
  }
  Ok "已登录：$Owner"
} else {
  if (-not $Owner) { $Owner = 'MuzeWinter' }
}

$entryName = "${Owner}__${RepoName}.yml"

# ---------- A) 建/推仓库 ----------
if (-not $PrOnly) {
  Step "A1 校正 package.json 里的 owner"
  $pkgPath = Join-Path $repoRoot 'package.json'
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $want = "git+https://github.com/$Owner/$RepoName.git"
  if ($pkg.repository.url -ne $want) {
    $pkg.repository.url = $want
    $pkg.homepage = "https://github.com/$Owner/$RepoName#readme"
    $pkg.bugs.url = "https://github.com/$Owner/$RepoName/issues"
    if ($DryRun) { Write-Host "  > 更新 package.json 的 repository/homepage/bugs 为 $Owner/$RepoName" -ForegroundColor DarkGray }
    else { [IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 10) + "`n", (New-Object Text.UTF8Encoding($false))); Ok "已更新为 $Owner/$RepoName" }
  } else { Ok "已是 $Owner/$RepoName" }

  Step "A2 git 初始化与提交"
  if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Run 'git' @('-C', $repoRoot, 'init', '-b', 'main') }
  Run 'git' @('-C', $repoRoot, 'add', '-A')
  if (-not $DryRun) {
    & git -C $repoRoot diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Ok "没有新改动需要提交" } else { Run 'git' @('-C', $repoRoot, 'commit', '-m', 'DScomputer-control 0.3.0: Windows GUI automation bridge for dsh') }
  }

  Step "A3 创建/推送 GitHub 仓库"
  $exists = $false
  if (-not $DryRun) { & gh repo view "$Owner/$RepoName" --json name 2>$null | Out-Null; $exists = ($LASTEXITCODE -eq 0) }
  if ($exists) {
    Ok "仓库已存在，直接推送"
    Run 'git' @('-C', $repoRoot, 'push', '-u', 'origin', 'main')
  } else {
    Run 'gh' @('repo', 'create', "$Owner/$RepoName", '--public', '--source', $repoRoot, '--push', '--description', $Description)
  }

  Step "A4 打 topic（市场要求 dsh-plugin）"
  Run 'gh' @('repo', 'edit', "$Owner/$RepoName", '--add-topic', 'dsh-plugin', '--add-topic', 'deepseek-harness', '--add-topic', 'cordis', '--add-topic', 'computer-use')

  if ($DryRun) { Write-Host "`n（DRY-RUN 结束：以上为建/推仓库阶段将执行的命令）" -ForegroundColor DarkGray; return }
  Ok "仓库地址 https://github.com/$Owner/$RepoName"
}

# ---------- B) 提市场 PR ----------
if (-not $RepoOnly) {
  Step "B1 检查仓库年龄（市场 CI 要求满 1 天）"
  $created = (& gh api "repos/$Owner/$RepoName" -q .created_at).Trim()
  $ageHours = 0
  if ($created) {
    $ageHours = [math]::Round(((Get-Date).ToUniversalTime() - ([datetime]$created).ToUniversalTime()).TotalHours, 1)
    Say "  仓库创建于 $created（$ageHours 小时前）"
  }
  if ($ageHours -lt 24 -and -not $Force) {
    Warn "未满 24 小时 —— 现在提 PR 会被 CI 标红（机械检查会挡住）。"
    Warn "建议 24 小时后再运行：pwsh -File .\market\push-to-market.ps1 -PrOnly"
    if (-not $DryRun) { exit 3 }
  }

  Step "B2 Fork 市场仓库"
  Run 'gh' @('repo', 'fork', $MarketRepo, '--clone=false', '--remote=false')

  Step "B3 克隆自己的 fork"
  $work = Join-Path $env:TEMP "awesome-dsh-plugin-pr-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  if ($DryRun) { Write-Host "  > gh repo clone $Owner/awesome-dsh-plugin $work -- --depth 1" -ForegroundColor DarkGray }
  else { Run 'gh' @('repo', 'clone', "$Owner/awesome-dsh-plugin", $work, '--', '--depth', '1') }

  Step "B4 写条目 data/plugins/$entryName"
  $entryDest = Join-Path $work "data\plugins\$entryName"
  $entry = if (Test-Path $entryTemplate) { [IO.File]::ReadAllText($entryTemplate) } else { '' }
  if (-not $entry) { Die "找不到条目模板 $entryTemplate" }
  $entry = $entry -replace 'https://github\.com/[^/]+/dscomputer-control', "https://github.com/$Owner/$RepoName"
  $entry = $entry -replace '(?m)^name: .+$', "name: $Owner/$RepoName"
  if ($DryRun) {
    Write-Host "  > 写入 $entryDest" -ForegroundColor DarkGray
    ($entry -split "`n") | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  } else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $entryDest) -Force | Out-Null
    [IO.File]::WriteAllText($entryDest, $entry, (New-Object Text.UTF8Encoding($false)))
    Ok "已写入 $entryDest"
  }

  Step "B5 提交并推送分支"
  $branch = "add/$RepoName"
  Run 'git' @('-C', $work, 'checkout', '-b', $branch)
  Run 'git' @('-C', $work, 'add', "data/plugins/$entryName")
  Run 'git' @('-C', $work, 'commit', '-m', "Add $Owner/$RepoName")
  Run 'git' @('-C', $work, 'push', '-u', 'origin', $branch)

  Step "B6 创建 PR"
  $body = @"
Adds one entry: ``data/plugins/$entryName``.

**What it is** — $Description

**Category** — ``tools``: the plugin ships 14 agent tools for desktop automation.

**Requirements met** — repo declares ``dsh.bundle`` in ``package.json`` (with ``cordis.patch.yml`` next to it), repo carries the ``dsh-plugin`` topic, real working code (pure JS, no dependencies).

**Notes for reviewers** — the plugin loads the official computer-use runtime that is already installed on the user's machine; the runtime binary is not shipped in this repo. It is located by enumerating vendor directories, so it is not pinned to a version or hash path.
"@
  $pr = Gh @('pr', 'create', '--repo', $MarketRepo, '--title', "Add $Owner/$RepoName", '--body', $body, '--head', "${Owner}:${branch}")
  if (-not $DryRun) { Ok "PR: $pr" }
  else { Write-Host "  > gh pr create --repo $MarketRepo --title 'Add $Owner/$RepoName' --head ${Owner}:${branch}" -ForegroundColor DarkGray }
}

Say ""
if ($DryRun) { Say "DRY-RUN 完成（未做任何改动）。" -ForegroundColor DarkGray }
else { Say "完成。若刚建完仓库，24 小时后重跑 -PrOnly 提交 PR 即可。" -ForegroundColor Green }
