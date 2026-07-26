param(
  [Parameter(Mandatory = $true)]
  [string]$ClusterName,
  [string]$DatabaseUrl = $env:WORLDLINE_DATABASE_URL,
  [string]$OutFile = "outputs/worldline-cluster-health.json"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ccloud -ErrorAction SilentlyContinue)) {
  throw "Install and authenticate the CockroachDB ccloud CLI first."
}

$outputDirectory = Split-Path -Parent $OutFile
if ($outputDirectory) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$clusterInfo = ccloud cluster info $ClusterName --format json | ConvertFrom-Json
$backups = ccloud cluster backup list $ClusterName --format json | ConvertFrom-Json

$receipt = [ordered]@{
  checkedAt = [DateTime]::UtcNow.ToString("o")
  cluster = $clusterInfo
  backups = $backups
  expectedRegions = @("us-east-1", "eu-west-1", "ap-south-1")
  sql = $null
}

if ($DatabaseUrl) {
  if (-not (Get-Command cockroach -ErrorAction SilentlyContinue)) {
    throw "The cockroach SQL shell is required when DatabaseUrl is supplied."
  }
  $sql = @"
SELECT json_build_object(
  'database', current_database(),
  'version', version(),
  'regions', (SELECT json_agg(region) FROM [SHOW REGIONS FROM DATABASE worldline]),
  'vectorIndex', EXISTS (
    SELECT 1 FROM [SHOW INDEXES FROM maneuver_memories]
    WHERE index_name = 'maneuver_memory_vector_idx'
  ),
  'changefeeds', (
    SELECT count(*) FROM [SHOW CHANGEFEED JOBS]
    WHERE status IN ('running', 'paused')
  )
);
"@
  $receipt.sql = cockroach sql --url $DatabaseUrl --format json --execute $sql |
    ConvertFrom-Json
}

$receipt | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutFile
Write-Output "WORLDLINE cluster health receipt written to $OutFile"
