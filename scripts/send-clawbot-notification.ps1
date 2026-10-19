[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Content
)

$runtimeRoot = Join-Path $env:LOCALAPPDATA 'ClawBotGateway\runtime'
$environmentFile = Join-Path $runtimeRoot '.env'
$gatewayBaseUrl = if ($env:CLAWBOT_NOTIFY_BASE_URL) { $env:CLAWBOT_NOTIFY_BASE_URL.TrimEnd('/') } else { 'http://127.0.0.1:6798' }

if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw "ClawBot Gateway environment file not found: $environmentFile"
}

$settings = @{}
Get-Content -LiteralPath $environmentFile -Encoding utf8 |
  Where-Object { $_ -match '^(?<key>[^=]+)=(?<value>.*)$' } |
  ForEach-Object { $settings[$Matches.key] = $Matches.value }

if (-not $settings.CLAWBOT_LOGIN_PASSWORD) {
  throw 'ClawBot Gateway login password is not configured'
}

$loginBody = @{ password = $settings.CLAWBOT_LOGIN_PASSWORD } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Method Post -Uri "$gatewayBaseUrl/auth/login" -ContentType 'application/json' -Body $loginBody
$adminHeaders = @{ Authorization = "Bearer $($login.token)" }
$tokenResponse = Invoke-RestMethod -Method Get -Uri "$gatewayBaseUrl/api/v1/notify/tokens" -Headers $adminHeaders
$notifyToken = @($tokenResponse.tokens) |
  Where-Object { $_.name -eq 'CareerWorkbench 网申提醒' -and $_.enabled } |
  Select-Object -First 1

if (-not $notifyToken) {
  throw 'CareerWorkbench ClawBot notification token is not configured'
}

$body = @{ content = $Content } | ConvertTo-Json -Compress
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
$sendHeaders = @{ Authorization = "Bearer $($notifyToken.token)" }
$maxAttempts = 3
$lastError = $null
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  try {
    $result = Invoke-RestMethod -Method Post -Uri "$gatewayBaseUrl/api/v1/notify/send" -Headers $sendHeaders -ContentType 'application/json; charset=utf-8' -Body $bodyBytes
    if (-not $result.success) {
      throw 'ClawBot notification was not accepted'
    }
    Write-Output 'sent'
    return
  } catch {
    $lastError = $_
    if ($attempt -lt $maxAttempts) {
      Start-Sleep -Seconds ([Math]::Min(4, [Math]::Pow(2, $attempt - 1)))
    }
  }
}

throw $lastError
