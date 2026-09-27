<#
  push-to-market.ps1 —— 把本仓库推到 GitHub，并向插件市场（awesome-dsh-plugin）提交收录 PR。

  前置（任选其一）：
      gh auth login                                # 浏览器授权
      $env:GH_TOKEN = '<含 repo scope 的令牌>'      # 或环境变量令牌

  用法：
      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -RepoOnly
          # 建/推仓库 + 打 topic（可重复执行）

      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -PrOnly
          # 提市场 PR（市场 CI 要求目标仓库创建满 1 天；未满会提示，加 -Force 可强提）

      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1
          # 全流程

      pwsh -ExecutionPolicy Bypass -File .\market\push-to-market.ps1 -DryRun
          # 预演：只打印将执行的命令

  注：本机若已用 GitHub Desktop / GCM 登录过，可用下面的方式把令牌交给 gh：
      $tok = ("protocol=https`nhost=github.com`n`n" | git credential fill | Select-String '^password=') -replace 'password=',''
      $env:GH_TOKEN = $tok.Trim()
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
$branch = "add/$RepoName"

function Say($m) { Write-Host $m }
function StepMsg($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }

# 注意：函数名不要叫 `Gh` / `Run` 之外的 gh —— PowerShell 大小写不敏感，
# 与可执行文件同名的函数会把 `& gh` 解析成自己，造成无限递归（call depth overflow）。
function Invoke-Tool {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$ToolArgs = @(), [switch]$Capture)
  $app = Get-Command $Exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $app) { Die "找不到可执行文件：$Exe" }
  if ($DryRun) { Write-Host "  > $Exe $($ToolArgs -join ' ')" -ForegroundColor DarkGray; return $null }
  if ($Capture) { $out = & $app.Source @ToolArgs 2>&1 } else { & $app.Source @ToolArgs }
  $code = $LASTEXITCODE
  if ($code -ne 0) { Die "$Exe 失败（退出码 $code）：$($ToolArgs -join ' ')" }
  if ($Capture) { return $out }
}

Say "=== DScomputer-control → 插件市场 ==="
Say "仓库目录 : $repoRoot"
Say "市场仓库 : $MarketRepo"
Say "模式     : $(if ($DryRun) { 'DRY-RUN（只打印）' } elseif ($PrOnly) { '只提 PR' } elseif ($RepoOnly) { '只建/推仓库' } else { '全流程' })"

# ---------- 0) 认证 ----------
if (-not $DryRun) {
  $login = $null
  try { $login = (& (Get-Command gh -CommandType Application | Select-Object -First 1).Source api user -q .login 2>$null) } catch { }
  if ($LASTEXITCODE -ne 0 -or -not $login) {
    Die @"
GitHub 凭据不可用。任选一种：
        a) gh auth login
        b) `$env:GH_TOKEN = '<含 repo scope 的令牌>'
    然后重新运行本脚本。
"@
  }
  if (-not $Owner) { $Owner = "$login".Trim() }
  if (-not $Owner) { Die "无法确定 GitHub 用户名，请用 -Owner <用户名> 指定" }
  Ok "已认证：$Owner"
} else {
  if (-not $Owner) { $Owner = 'MuzeWinter' }
}
$entryName = "${Owner}__${RepoName}.yml"

# ---------- A) 建/推仓库 ----------
if (-not $PrOnly) {
  StepMsg "A1 校正 package.json 里的 owner"
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

  StepMsg "A2 git 提交"
  if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Invoke-Tool git @('-C', $repoRoot, 'init', '-b', 'main') }
  Invoke-Tool git @('-C', $repoRoot, 'add', '-A')
  if (-not $DryRun) {
    & (Get-Command git -CommandType Application | Select-Object -First 1).Source -C $repoRoot diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Ok "没有新改动需要提交" }
    else { Invoke-Tool git @('-C', $repoRoot, 'commit', '-m', "DScomputer-control: Windows GUI automation bridge for dsh") }
  }

  StepMsg "A3 创建/推送 GitHub 仓库"
  $exists = $false
  if (-not $DryRun) {
    & (Get-Command gh -CommandType Application | Select-Object -First 1).Source repo view "$Owner/$RepoName" --json name 2>$null | Out-Null
    $exists = ($LASTEXITCODE -eq 0)
  }
  if ($exists) {
    Ok "仓库已存在，直接推送"
    Invoke-Tool git @('-C', $repoRoot, 'push', '-u', 'origin', 'main')
  } else {
    Invoke-Tool gh @('repo', 'create', "$Owner/$RepoName", '--public', '--source', $repoRoot, '--push', '--description', $Description)
  }

  StepMsg "A4 打 topic（市场要求 dsh-plugin）"
  Invoke-Tool gh @('repo', 'edit', "$Owner/$RepoName", '--add-topic', 'dsh-plugin', '--add-topic', 'deepseek-harness', '--add-topic', 'cordis', '--add-topic', 'computer-use')
  if (-not $DryRun) { Ok "仓库地址 https://github.com/$Owner/$RepoName" }
}

# ---------- B) 提市场 PR ----------
if (-not $RepoOnly) {
  StepMsg "B1 检查仓库年龄（市场 CI 要求满 1 天）"
  $created = ''
  if (-not $DryRun) {
    $created = (& (Get-Command gh -CommandType Application | Select-Object -First 1).Source api "repos/$Owner/$RepoName" -q .created_at | Out-String).Trim()
  }
  $ageHours = 0
  if ($created) {
    $ageHours = [math]::Round(((Get-Date).ToUniversalTime() - ([datetime]$created).ToUniversalTime()).TotalHours, 1)
    Say "  仓库创建于 $created（$ageHours 小时前）"
  }
  if ($ageHours -lt 24 -and -not $Force) {
    Warn "未满 24 小时 —— 现在提 PR 会被市场 CI 标红（机械检查只看年龄，24 小时后自动转绿）。"
    Warn "建议稍后再运行：pwsh -File .\market\push-to-market.ps1 -PrOnly"
    if (-not $DryRun) { exit 3 }
  }

  StepMsg "B2 确保 fork 存在"
  $forkExists = $false
  if (-not $DryRun) {
    & (Get-Command gh -CommandType Application | Select-Object -First 1).Source api "repos/$Owner/$(Split-Path $MarketRepo -Leaf)" -q .full_name 2>$null | Out-Null
    $forkExists = ($LASTEXITCODE -eq 0)
  }
  if ($forkExists) { Ok "fork 已存在" }
  else { Invoke-Tool gh @('repo', 'fork', $MarketRepo, '--clone=false') }

  StepMsg "B3 准备分支 $branch"
  $work = Join-Path $env:TEMP "awesome-dsh-plugin-pr-$RepoName"
  if ($DryRun) {
    Write-Host "  > gh repo clone $Owner/$(Split-Path $MarketRepo -Leaf) $work -- --depth 1" -ForegroundColor DarkGray
    Write-Host "  > git checkout -b $branch / 写入 data/plugins/$entryName / commit / push" -ForegroundColor DarkGray
  } else {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-Tool gh @('repo', 'clone', "$Owner/$(Split-Path $MarketRepo -Leaf)", $work, '--', '--depth', '1')
    Invoke-Tool git @('-C', $work, 'checkout', '-b', $branch)
    $entry = [IO.File]::ReadAllText($entryTemplate)
    $entry = $entry -replace 'https://github\.com/[^/]+/dscomputer-control', "https://github.com/$Owner/$RepoName"
    $entry = $entry -replace '(?m)^name: .+$', "name: $Owner/$RepoName"
    $dest = Join-Path $work "data\plugins\$entryName"
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    [IO.File]::WriteAllText($dest, $entry, (New-Object Text.UTF8Encoding($false)))
    Invoke-Tool git @('-C', $work, 'add', "data/plugins/$entryName")
    Invoke-Tool git @('-C', $work, '-c', 'user.name=Muze', '-c', 'user.email=103491231+MuzeWinter@users.noreply.github.com', 'commit', '-m', "Add $Owner/$RepoName")
    Invoke-Tool git @('-C', $work, 'push', '-u', 'origin', $branch)
  }

  StepMsg "B4 创建 PR"
  $body = "Adds one entry: ``data/plugins/$entryName``.`n`n**What it is** — $Description`n`n**Category** — ``tools``: the plugin ships 14 agent tools for desktop automation.`n`n**Requirements met** — repo declares ``dsh.bundle`` in ``package.json`` (with ``cordis.patch.yml`` next to it), repo carries the ``dsh-plugin`` topic, real working code (pure JS, no dependencies).`n`n**Notes for reviewers** — the plugin loads the official computer-use runtime already installed on the user's machine; the runtime binary is not shipped in this repo. It is located by enumerating vendor directories, so it is not pinned to a version or hash path."
  if ($DryRun) {
    Write-Host "  > gh pr create --repo $MarketRepo --title 'Add $Owner/$RepoName' --head ${Owner}:${branch} --body <摘要>" -ForegroundColor DarkGray
  } else {
    $pr = Invoke-Tool gh @('pr', 'create', '--repo', $MarketRepo, '--title', "Add $Owner/$RepoName", '--body', $body, '--head', "${Owner}:${branch}") -Capture
    Ok "PR: $pr"
  }
}

Say ""
if ($DryRun) { Say "DRY-RUN 完成（未做任何改动）。" -ForegroundColor DarkGray }
else { Say "完成。" -ForegroundColor Green }
