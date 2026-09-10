param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('context', 'report')]
  [string]$Command,

  [string]$EndpointFile = $env:ZERO3_REPORTER_ENDPOINT_FILE,
  [string]$Ticket = $env:ZERO3_ASSIGNMENT_TICKET,
  [string]$ReportId,
  [string]$Type,
  [string]$AssignmentId,
  [string]$PayloadJson = '{}'
)

$ErrorActionPreference = 'Stop'

function Require-Text([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label is required" }
  return $Value.Trim()
}

function Decode-TicketPayload([string]$Value) {
  $parts = $Value.Split('.')
  if ($parts.Length -ne 3 -or $parts[0] -ne 'z3r1') { throw 'ticket is malformed' }
  $encoded = $parts[1].Replace('-', '+').Replace('_', '/')
  switch ($encoded.Length % 4) {
    2 { $encoded += '==' }
    3 { $encoded += '=' }
    1 { throw 'ticket payload is malformed' }
  }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  return $json | ConvertFrom-Json
}

$EndpointFile = Require-Text $EndpointFile 'endpoint-file'
$Ticket = Require-Text $Ticket 'ticket'
$endpoint = Get-Content -LiteralPath $EndpointFile -Raw | ConvertFrom-Json
if ($endpoint.protocol -ne 'zero3.pilot.execution-reporter-endpoint.v1') { throw 'reporter endpoint descriptor is invalid' }
$uri = [Uri]$endpoint.origin
if ($uri.Scheme -ne 'http') { throw 'reporter endpoint must use loopback HTTP' }
$ip = $null
if (-not [Net.IPAddress]::TryParse($uri.Host, [ref]$ip) -or -not [Net.IPAddress]::IsLoopback($ip)) {
  throw 'reporter endpoint must be loopback HTTP'
}
$headers = @{ Authorization = "Bearer $($endpoint.bearerToken)" }

if ($Command -eq 'context') {
  $body = @{ ticket = $Ticket } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri ([Uri]::new($uri, '/v1/context')) -Headers $headers -ContentType 'application/json' -Body $body
  $result | ConvertTo-Json -Depth 32
  exit 0
}

$ReportId = Require-Text $ReportId 'report-id'
$Type = Require-Text $Type 'type'
if ([string]::IsNullOrWhiteSpace($AssignmentId)) {
  $AssignmentId = Require-Text (Decode-TicketPayload $Ticket).assignmentId 'assignment-id'
}
$payload = $PayloadJson | ConvertFrom-Json
if ($null -eq $payload -or $payload -is [Array]) { throw 'payload-json must decode to an object' }
$body = @{
  protocol = 'zero3.pilot.execution-report.v1'
  reportId = $ReportId
  assignmentId = $AssignmentId
  ticket = $Ticket
  type = $Type
  payload = $payload
  sentAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Depth 32 -Compress
$result = Invoke-RestMethod -Method Post -Uri ([Uri]::new($uri, '/v1/report')) -Headers $headers -ContentType 'application/json' -Body $body
$result | ConvertTo-Json -Depth 32
