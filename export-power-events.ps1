# Exports this PC's power history (boot, shutdown, sleep, wake, power loss) from the Windows
# System event log, so WireView Log Viewer can put real dates on the WireView's uptime log.
# Read-only: it only reads the event log and writes one CSV file.
param([string]$OutDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'))

$ErrorActionPreference = 'Stop'
$rows = New-Object System.Collections.Generic.List[object]

function Add-Row([datetime]$time, [string]$kind, [int]$id, [string]$source) {
    $rows.Add([pscustomobject]@{
        TimeUtc = $time.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        Kind    = $kind
        Id      = $id
        Source  = $source
    })
}

function Get-Events([hashtable]$filter) {
    try { Get-WinEvent -FilterHashtable $filter }
    catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { @() } else { throw } }
}

function Get-EventData($evt, [string]$name) {
    $xml = [xml]$evt.ToXml()
    ($xml.Event.EventData.Data | Where-Object { $_.Name -eq $name }).'#text'
}

# Boot and shutdown
foreach ($e in Get-Events @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 12, 13 }) {
    Add-Row $e.TimeCreated ($(if ($e.Id -eq 12) { 'boot' } else { 'shutdown' })) $e.Id 'Kernel-General'
}

# Sleep and wake (exact times from the Power-Troubleshooter event)
$sleepTimes = @()
foreach ($e in Get-Events @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1 }) {
    $sleep = Get-EventData $e 'SleepTime'
    $wake = Get-EventData $e 'WakeTime'
    if ($sleep) {
        $t = [datetime]::Parse($sleep, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        Add-Row $t 'sleep' 1 'Power-Troubleshooter'
        $sleepTimes += $t.ToUniversalTime()
    }
    if ($wake) { Add-Row ([datetime]::Parse($wake, $null, [Globalization.DateTimeStyles]::RoundtripKind)) 'wake' 1 'Power-Troubleshooter' }
}

# Entering sleep, only where no Power-Troubleshooter record covers it
foreach ($e in Get-Events @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42 }) {
    $t = $e.TimeCreated.ToUniversalTime()
    if (-not ($sleepTimes | Where-Object { [math]::Abs(($_ - $t).TotalSeconds) -lt 180 })) { Add-Row $e.TimeCreated 'sleep' 42 'Kernel-Power' }
}

# Unexpected shutdowns (power loss, crash): the event carries the last known running time in UTC
foreach ($e in Get-Events @{ LogName = 'System'; ProviderName = 'EventLog'; Id = 6008 }) {
    $b = $e.Properties[7].Value
    if ($b -is [byte[]] -and $b.Length -ge 32) {
        $w = 0..7 | ForEach-Object { [BitConverter]::ToUInt16($b, 16 + 2 * $_) }
        $t = New-Object DateTime ($w[0], $w[1], $w[3], $w[4], $w[5], $w[6], $w[7], [DateTimeKind]::Utc)
        Add-Row $t 'powerloss' 6008 'EventLog'
    }
}

if (-not $rows.Count) { throw 'No power events found in the System event log.' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$file = Join-Path $OutDir ('power-events-{0}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$rows | Sort-Object TimeUtc | Export-Csv -Path $file -NoTypeInformation -Encoding UTF8

$sorted = $rows | Sort-Object TimeUtc
Write-Host ("Saved {0} power events ({1} to {2})" -f $rows.Count, $sorted[0].TimeUtc.Substring(0, 10), $sorted[-1].TimeUtc.Substring(0, 10))
Write-Host $file
Write-Host 'Drop this file into WireView Log Viewer together with your .wvl file.'
