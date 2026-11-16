# Run interactively; the API key is held only in process memory.
$secret = Read-Host 'Paste your Watchmode API key (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $key = [regex]::Replace($key, '\x1b\[20[01]~', '')
  $key = [regex]::Replace($key, '[\x00-\x1f\x7f]', '').Trim()
  try { $null = Invoke-RestMethod -Uri 'https://api.watchmode.com/v1/status/' -Headers @{ 'X-API-Key' = $key } -TimeoutSec 20 -ErrorAction Stop } catch { if ($_.Exception.Response) { Write-Host ('Authentication check returned HTTP ' + [int]$_.Exception.Response.StatusCode) } else { Write-Host ('Connection error: ' + $_.Exception.GetType().Name); if ([string]::IsNullOrEmpty($key)) { Write-Host 'No key was received.' } elseif ($key -match '[\r\n\x00-\x1f]') { Write-Host 'The pasted value contains a control character.' } else { Write-Host ('Error details: ' + $_.Exception.Message.Replace($key, '[redacted]')) } }; return }
  $cases = @(@{ Label='Suits (2011)'; Id='tv-37680' }, @{ Label='Dune (2021)'; Id='movie-438631' }, @{ Label='Dune (1984)'; Id='movie-841' })
  $results = @()
  foreach ($case in $cases) {
    $uri = 'https://api.watchmode.com/v1/title/' + $case.Id + '/sources/?regions=US'
    try {
      $rows = Invoke-RestMethod -Uri $uri -Headers @{ 'X-API-Key' = $key } -TimeoutSec 20 -ErrorAction Stop
      $eligible = @($rows | Where-Object { $_.region -eq 'US' -and $_.web_url -match '^https://' -and -not $_.web_url.Contains($key) })
      $results += [pscustomobject]@{ title=$case.Label; id=$case.Id; candidates=@($eligible | Select-Object name, type, region, web_url) }
      Write-Host ($case.Label + ': ' + $eligible.Count + ' HTTPS link candidates')
      $eligible | Select-Object name, type, region, web_url | Format-Table -AutoSize
    } catch {
      $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'connection error' }
      $results += [pscustomobject]@{ title=$case.Label; id=$case.Id; error=$status }
      Write-Host ($case.Label + ': request failed (' + $status + ')')
    }
  }
  $results | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'watchmode-benchmark-results.json')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable key, secret, uri -ErrorAction SilentlyContinue
}
