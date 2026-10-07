#requires -Version 7.0
[CmdletBinding()]
param(
  [string]$InstalledSkills,
  [string]$GitProxy,
  [switch]$SkipRemote,
  [switch]$SkipGitClean,
  [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -ne 7) {
  throw 'PowerShell 7 Core is required'
}
$MainRepo = Split-Path $PSScriptRoot -Parent
$ResumeRoot = Split-Path $MainRepo -Parent
$RepoSkills = Join-Path $MainRepo 'skills'
if (-not $InstalledSkills) { $InstalledSkills = Join-Path $ResumeRoot '.agents\skills' }
if (-not $GitProxy) { $GitProxy = git config --global --get http.proxy 2>$null }
if (-not $GitProxy) {
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $connected = $client.ConnectAsync('127.0.0.1', 7890).Wait(200)
    if ($connected -and $client.Connected) { $GitProxy = 'http://127.0.0.1:7890' }
    $client.Dispose()
  } catch {}
}

$failures = [System.Collections.Generic.List[string]]::new()

function Invoke-Step([string]$Name, [scriptblock]$Body) {
  try {
    & $Body
    Write-Host "[PASS] $Name"
  } catch {
    $failures.Add("$Name :: $($_.Exception.Message)")
    Write-Host "[FAIL] $Name :: $($_.Exception.Message)"
  }
}

function Assert-Native([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label exited with code $LASTEXITCODE" }
}

function Invoke-CapturedNative([string]$Label, [scriptblock]$Body) {
  $output = @(& $Body 2>&1)
  $code = $LASTEXITCODE
  if ($VerboseOutput -or $code -ne 0) {
    $output | ForEach-Object { Write-Host $_ }
  }
  if ($code -ne 0) { throw "$Label exited with code $code" }
}

function Get-RemoteMain([string]$Repo, [string]$Remote) {
  $args = @('-C', $Repo)
  if ($GitProxy) { $args += @('-c',"http.proxy=$GitProxy",'-c',"https.proxy=$GitProxy") }
  $args += @('ls-remote', $Remote, 'refs/heads/main')
  $line = & git @args
  Assert-Native "git ls-remote $Remote"
  if (-not $line) { throw "remote main not found for $Remote" }
  return ($line -split '\s+')[0]
}

Invoke-Step 'repositories exist' {
  if (!(Test-Path $RepoSkills) -or !(Test-Path $InstalledSkills)) {
    throw 'repository skills/ or installed-skill path missing'
  }
}

if ($SkipGitClean) {
  Write-Host '[SKIP] git worktrees clean'
} else {
  Invoke-Step 'git worktrees clean' {
    foreach ($repo in @($MainRepo)) {
      $dirty = @(git -C $repo status --porcelain)
      Assert-Native 'git status'
      if ($dirty.Count) { throw "dirty worktree: $repo" }
    }
  }
}

Invoke-Step 'private data is not tracked' {
  $tracked = @(git -C $MainRepo ls-files data/private)
  Assert-Native 'git ls-files data/private'
  if ($tracked.Count) { throw "$($tracked.Count) private files are tracked" }
}

Invoke-Step 'installed skills match repository skills/' {
  # Same comparison as `npm run skills:check`: CRLF/LF differences and caches are ignored
  $env:JOBHUNT_INSTALLED_SKILLS = $InstalledSkills
  Invoke-CapturedNative 'skills-sync.js' { & node (Join-Path $MainRepo 'scripts\skills-sync.js') }
}

Invoke-Step 'site knowledge metadata' {
  Invoke-CapturedNative 'site-knowledge-status.js' { & node (Join-Path $MainRepo 'scripts\site-knowledge-status.js') --json }
}

Invoke-Step 'CareerWorkbench node tests' {
  $tests = @(
    Get-ChildItem (Join-Path $MainRepo 'dashboard'),(Join-Path $MainRepo 'discovery'),(Join-Path $MainRepo 'scripts'),(Join-Path $MainRepo 'mcp') -Filter '*.test.js' -File |
      ForEach-Object { $_.FullName }
  )
  Invoke-CapturedNative 'node --test' { & node --test @tests }
}

Invoke-Step 'public skill bundle' {
  $py = (Get-Command python -ErrorAction Stop).Source
  foreach ($dir in @('skills', 'docs\skills', 'schemas', 'examples')) {
    Invoke-CapturedNative "public-safety-check $dir" { & $py -X utf8 (Join-Path $MainRepo 'scripts\public-safety-check.py') (Join-Path $MainRepo $dir) }
  }
  Invoke-CapturedNative 'validate-skill-structure.py' { & $py -X utf8 (Join-Path $MainRepo 'scripts\validate-skill-structure.py') $MainRepo }
  Invoke-CapturedNative 'example matching' { & $py -X utf8 (Join-Path $RepoSkills 'campus-recruitment\scripts\verify-matching.py') (Join-Path $MainRepo 'examples\vla-evidence\matching.json') }
}

Invoke-Step 'CareerWorkbench agent tests' {
  $AgentDir = Join-Path $MainRepo 'agent'
  $AgentTests = Join-Path $AgentDir 'tests'
  Invoke-CapturedNative 'agent pytest' {
    & uv run --project $AgentDir --frozen python -X utf8 -m pytest $AgentTests -q
  }
}

if ($SkipRemote) {
  Write-Host '[SKIP] remote main heads are synchronized'
} else {
  Invoke-Step 'remote main heads are synchronized' {
    foreach ($item in @(@($MainRepo,'origin'))) {
      $local = (git -C $item[0] rev-parse HEAD).Trim()
      Assert-Native 'git rev-parse'
      $remote = Get-RemoteMain $item[0] $item[1]
      if ($local -ne $remote) { throw "$($item[0]) local=$local remote=$remote" }
    }
  }
}

if ($failures.Count) {
  Write-Host ''
  Write-Host "OVERALL: FAIL ($($failures.Count))"
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host ''
Write-Host 'OVERALL: PASS'
