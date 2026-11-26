param(
    [string]$ServerUrl = $env:ITMS_SERVER_URL,
    [string]$TokenFile,
    [switch]$PromptToken,
    [string]$AssetTag = $env:ITMS_ASSET_TAG,
    [string]$Name = $env:ITMS_ASSET_NAME,
    [string]$Category = $(if ($env:ITMS_ASSET_CATEGORY) { $env:ITMS_ASSET_CATEGORY } else { 'auto' }),
    [string]$AssignedToEmail = $env:ITMS_ASSIGNED_TO_EMAIL,
    [string]$AssignedToName = $env:ITMS_ASSIGNED_TO_NAME,
    [string]$EmployeeCode = $env:ITMS_EMPLOYEE_CODE,
    [string]$DepartmentName = $env:ITMS_DEPARTMENT_NAME,
    [string]$EntityId = $env:ITMS_ENTITY_ID,
    [string]$DeptId = $env:ITMS_DEPT_ID,
    [string]$LocationId = $env:ITMS_LOCATION_ID,
    [string]$PurchaseDate = $env:ITMS_PURCHASE_DATE,
    [string]$WarrantyUntil = $env:ITMS_WARRANTY_UNTIL,
    [string]$Status = $(if ($env:ITMS_ASSET_STATUS) { $env:ITMS_ASSET_STATUS } else { 'in_use' }),
    [string]$Condition = $(if ($env:ITMS_ASSET_CONDITION) { $env:ITMS_ASSET_CONDITION } else { 'good' }),
    [string]$SaltMinionId = $env:ITMS_SALT_MINION_ID,
    [string]$WazuhAgentId = $env:ITMS_WAZUH_AGENT_ID,
    [string]$Notes = $(if ($env:ITMS_ASSET_NOTES) { $env:ITMS_ASSET_NOTES } else { $env:ITMS_NOTES }),
    [string]$SourceFingerprint = $env:ITMS_SOURCE_FINGERPRINT,
    [bool]$UseDetailedHardwareInventory = $true,
    [ValidateRange(1, 10000)]
    [int]$SoftwareLimit = 5000,
    [ValidateRange(1, 10000)]
    [int]$ServiceLimit = 5000,
    [switch]$IncludeClamAvReport,
    [string[]]$ClamAvScanPaths,
    [int]$ClamAvTimeoutSeconds = 7200,
    [switch]$NoSoftwareScan,
    [switch]$PrintOnly,
    [switch]$HeartbeatOnly,
    [switch]$HeartbeatLoop,
    [switch]$InventoryOnly,
    [int]$TimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ConfigFile = 'C:\ProgramData\ITMS\itms-agent.env'

function Read-ValueFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        throw ('Value file not found: ' + $Path)
    }

    return (([string](Get-Content -LiteralPath $Path -Raw)) -replace '[\r\n]+$','')
}

function Read-SecretPrompt {
    param([string]$Label)

    $secureValue = Read-Host -Prompt $Label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return ([string][Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)).Trim()
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Get-ConfigValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return ''
    }

    foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
        if ($line.StartsWith($Key + '=')) {
            return $line.Substring($Key.Length + 1).Trim()
        }
    }

    return ''
}

function Resolve-ConfiguredValue {
    param(
        [string]$ExplicitValue,
        [string]$ConfigKey
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitValue)) {
        return $ExplicitValue.Trim()
    }

    return (Get-ConfigValue -Path $ConfigFile -Key $ConfigKey)
}

function Resolve-IngestToken {
    if (-not [string]::IsNullOrWhiteSpace($TokenFile)) {
        return (Read-ValueFile -Path $TokenFile)
    }
    if ($PromptToken) {
        return (Read-SecretPrompt -Label 'Inventory ingest token')
    }
    return (Resolve-ConfiguredValue -ExplicitValue $env:ITMS_INGEST_TOKEN -ConfigKey 'ITMS_INGEST_TOKEN')
}

$script:ServerUrl = Resolve-ConfiguredValue -ExplicitValue $ServerUrl -ConfigKey 'ITMS_SERVER_URL'
$script:Token = Resolve-IngestToken

$configKeys = @{ Category = 'ITMS_ASSET_CATEGORY'; AssetTag = 'ITMS_ASSET_TAG'; Name = 'ITMS_ASSET_NAME'; Notes = 'ITMS_ASSET_NOTES'; AssignedToEmail = 'ITMS_ASSIGNED_TO_EMAIL'; AssignedToName = 'ITMS_ASSIGNED_TO_NAME'; EmployeeCode = 'ITMS_EMPLOYEE_CODE'; DepartmentName = 'ITMS_DEPARTMENT_NAME' }
foreach ($entry in $configKeys.GetEnumerator()) {
    if (-not $PSBoundParameters.ContainsKey($entry.Key)) {
        $value = Get-ConfigValue -Path $ConfigFile -Key $entry.Value
        if (-not [string]::IsNullOrWhiteSpace($value)) { Set-Variable -Name $entry.Key -Value $value -Scope Script }
    }
}
if (-not $PSBoundParameters.ContainsKey('UseDetailedHardwareInventory')) {
    $setting = Get-ConfigValue -Path $ConfigFile -Key 'ITMS_USE_DETAILED_HARDWARE_INVENTORY'
    if ($setting -eq 'false') { $UseDetailedHardwareInventory = $false }
}

if ((-not $ClamAvScanPaths -or $ClamAvScanPaths.Count -eq 0) -and -not [string]::IsNullOrWhiteSpace($env:ITMS_CLAMAV_SCAN_PATHS)) {
    $ClamAvScanPaths = @($env:ITMS_CLAMAV_SCAN_PATHS -split '[,;]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })
}
if (-not $ClamAvScanPaths -or $ClamAvScanPaths.Count -eq 0) {
    $ClamAvScanPaths = @('C:\Users', 'C:\ProgramData', 'C:\Temp')
}

function Format-Bytes {
    param([UInt64]$Bytes)

    if ($Bytes -le 0) {
        return 'Unknown'
    }

    $units = @('B', 'KB', 'MB', 'GB', 'TB', 'PB')
    $value = [double]$Bytes
    $unitIndex = 0
    while ($value -ge 1024 -and $unitIndex -lt ($units.Length - 1)) {
        $value = $value / 1024
        $unitIndex += 1
    }

    if ($value -ge 100 -or $unitIndex -eq 0) {
        return ('{0} {1}' -f [int][Math]::Round($value), $units[$unitIndex])
    }
    return ('{0:N1} {1}' -f $value, $units[$unitIndex])
}

function Normalize-Endpoint {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return 'http://localhost:3001/api/inventory-sync/ingest'
    }

    if ($Value -notmatch '^[a-z]+://') {
        $Value = 'http://' + $Value
    }

    if ($Value.EndsWith('/api/inventory-sync/ingest')) {
        return $Value
    }

    return $Value.TrimEnd('/') + '/api/inventory-sync/ingest'
}

function Get-UpdateScan {
    $status = @{ status = 'failed'; source = 'windows_update'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); error = 'scan failed or timed out'; scope = 'Windows Update software updates' }
    $scan = @{ count = $null; details = @(); reboot = $null; section = $status }
    $job = $null
    try {
        # Isolate synchronous COM in a killable process; search once for both count and details.
        $job = Start-Job -ScriptBlock {
            $ErrorActionPreference = 'Stop'
            $session = New-Object -ComObject Microsoft.Update.Session
            $searcher = $session.CreateUpdateSearcher()
            $result = $searcher.Search("IsInstalled=0 and Type='Software'")
            if ([int]$result.ResultCode -ne 2) { throw 'Incomplete Windows Update search' }
            $titles = @($result.Updates | ForEach-Object { [string]$_.Title } | Sort-Object -Unique)
            $system = New-Object -ComObject Microsoft.Update.SystemInfo
            @{ count = $titles.Count; details = @($titles | Select-Object -First 5000); reboot = [bool]$system.RebootRequired }
        }
        if (Wait-Job -Job $job -Timeout 120) {
            $result = Receive-Job -Job $job -ErrorAction Stop
            if ($job.State -eq 'Completed' -and $null -ne $result) {
                $scan.details = @($result.details)
                $scan.reboot = $result.reboot
                $status.status = 'success'
                $status.Remove('error')
                $status.total = $result.count
                $status.returned = $scan.details.Count
                $status.truncated = ($result.count -gt 5000)
                if ($status.truncated) { $status.status = 'partial' } else { $scan.count = $result.count }
            }
        }
    } catch {
        # Never include COM/native exception text, which can contain local configuration.
    } finally {
        if ($null -ne $job) { Stop-Job -Job $job -ErrorAction SilentlyContinue; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    }
    return $scan
}

function Get-ServiceScan {
    param([int]$Limit = 5000)
    $Limit = [Math]::Max(1, [Math]::Min($Limit, 10000))
    $section = @{ status = 'failed'; source = 'win32_service'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); scope = 'machine Win32_Service; excludes drivers and other user sessions'; error = 'service query failed or timed out' }
    $scan = @{ services = @(); section = $section }
    $job = $null
    try {
        $job = Start-Job -ArgumentList $Limit -ScriptBlock {
            param($Limit)
            $ErrorActionPreference = 'Stop'
            # Explicit projection: never request PathName, StartName or credentials.
            $rows = @(Get-CimInstance -ClassName Win32_Service -Property Name,DisplayName,State,StartMode -OperationTimeoutSec 45 -ErrorAction Stop | Sort-Object Name -Unique)
            $invalid = $false
            $validRows = @(foreach ($row in $rows) {
                $name = [string]$row.Name
                if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 256 -or $name -match '\p{Cc}') {
                    $invalid = $true
                    continue
                }
                $row
            })
            $services = @($validRows | Select-Object -First $Limit | ForEach-Object {
                $name = [string]$_.Name
                $display = [string]$_.DisplayName
                $state = ([string]$_.State).ToLowerInvariant()
                $mode = ([string]$_.StartMode).ToLowerInvariant()
                if ($display.Length -gt 256 -or $display -match '\p{Cc}') { $invalid = $true }
                if ($state.Length -gt 64 -or $mode.Length -gt 64 -or $state -match '\p{Cc}' -or $mode -match '\p{Cc}' -or [string]::IsNullOrWhiteSpace($state) -or [string]::IsNullOrWhiteSpace($mode)) {
                    $invalid = $true
                    $state = 'unknown'
                    $mode = 'unknown'
                }
                $display = $display -replace '\p{Cc}', ''
                @{ name = $name; display_name = $display.Substring(0, [Math]::Min(256, $display.Length)); state = $state.Substring(0, [Math]::Min(64, $state.Length)); start_mode = $mode.Substring(0, [Math]::Min(64, $mode.Length)); source = 'win32_service' }
            })
            @{ services = $services; total = $rows.Count; invalid = $invalid }
        }
        if (Wait-Job -Job $job -Timeout 60) {
            $result = Receive-Job -Job $job -ErrorAction Stop
            if ($job.State -eq 'Completed' -and $null -ne $result) {
                $scan.services = @($result.services)
                $section.total = $result.total
                $section.returned = $scan.services.Count
                $section.truncated_count = [Math]::Max(0, $result.total - $scan.services.Count)
                $section.truncated = ($section.truncated_count -gt 0)
                $section.status = $(if ($section.truncated) { 'partial' } else { 'success' })
                $section.Remove('error')
                if ($result.invalid) {
                    $section.status = $(if ($scan.services.Count -gt 0) { 'partial' } else { 'failed' })
                    $section.error = 'invalid or bounded service metadata'
                }
            }
        }
    } catch {
        # Do not serialize native exception text or arbitrary CIM properties.
    } finally {
        if ($null -ne $job) { Stop-Job -Job $job -ErrorAction SilentlyContinue; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    }
    return $scan
}

function Get-LoggedInUsers {
    $users = New-Object System.Collections.Generic.List[string]
    $seen = @{}

    function Add-UserCandidate {
        param([string]$Value)
        if ([string]::IsNullOrWhiteSpace($Value)) {
            return
        }
        $candidate = $Value.Trim()
        if ([string]::IsNullOrWhiteSpace($candidate) -or $seen.ContainsKey($candidate)) {
            return
        }
        $seen[$candidate] = $true
        $users.Add($candidate)
    }

    try {
        $computerSystemUser = [string]$computer.UserName
        if ($computerSystemUser -match '\\') {
            Add-UserCandidate -Value ($computerSystemUser.Split('\\')[-1])
        } else {
            Add-UserCandidate -Value $computerSystemUser
        }
    } catch {
    }

    try {
        foreach ($line in (quser 2>$null | Select-Object -Skip 1)) {
            $normalized = ([string]$line).Trim()
            if ([string]::IsNullOrWhiteSpace($normalized)) {
                continue
            }
            $normalized = $normalized.TrimStart('>')
            $parts = $normalized -split '\s+'
            if ($parts.Length -gt 0) {
                Add-UserCandidate -Value $parts[0]
            }
        }
    } catch {
    }

    return @($users)
}

function Get-PrimaryMacAddress {
    try {
        $adapter = Get-NetAdapter -Physical -ErrorAction Stop |
            Where-Object { $_.Status -eq 'Up' -and -not [string]::IsNullOrWhiteSpace($_.MacAddress) } |
            Select-Object -First 1
        if ($null -ne $adapter -and -not [string]::IsNullOrWhiteSpace($adapter.MacAddress)) {
            return $adapter.MacAddress.Trim().ToLowerInvariant().Replace('-', ':')
        }
    } catch {
    }

    try {
        $adapter = Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop |
            Where-Object { $_.PhysicalAdapter -and -not [string]::IsNullOrWhiteSpace($_.MACAddress) -and $_.NetEnabled } |
            Select-Object -First 1
        if ($null -ne $adapter -and -not [string]::IsNullOrWhiteSpace($adapter.MACAddress)) {
            return $adapter.MACAddress.Trim().ToLowerInvariant()
        }
    } catch {
    }

    return ''
}

function Get-GpuDescription {
    try {
        $names = Get-CimInstance Win32_VideoController -ErrorAction Stop |
            ForEach-Object { $_.Name } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
        if ($names) {
            return (($names | ForEach-Object { $_.Trim() }) -join '; ')
        }
    } catch {
    }

    return ''
}

function Get-DisplayDescription {
    try {
        $descriptions = Get-CimInstance Win32_VideoController -ErrorAction Stop |
            ForEach-Object {
                if ($_.CurrentHorizontalResolution -and $_.CurrentVerticalResolution) {
                    '{0} {1}x{2}' -f $_.Name, $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution
                } elseif (-not [string]::IsNullOrWhiteSpace($_.VideoModeDescription)) {
                    '{0} {1}' -f $_.Name, $_.VideoModeDescription
                } else {
                    $null
                }
            } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
        if ($descriptions) {
            return (($descriptions | ForEach-Object { $_.Trim() }) -join '; ')
        }
    } catch {
    }

    return ''
}

function Format-UtcTimestamp {
    param($Value)

    if ($null -eq $Value) {
        return ''
    }

    try {
        return ([DateTime]$Value).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    } catch {
        return ''
    }
}

function Truncate-Text {
    param(
        [string]$Value,
        [int]$Limit = 20000
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }

    $trimmed = $Value.Trim()
    if ($trimmed.Length -le $Limit) {
        return $trimmed
    }

    return $trimmed.Substring(0, $Limit - 16).TrimEnd() + "`n... output truncated"
}

function Get-ExecutablePath {
    param(
        [string[]]$Commands,
        [string[]]$CandidatePaths = @()
    )

    foreach ($commandName in $Commands) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
            return $command.Source
        }
    }

    foreach ($candidate in $CandidatePaths) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return ''
}

function Get-RemoteAccessId {
    param(
        [string[]]$Commands,
        [string[]]$Arguments = @('--get-id'),
        [string[]]$CandidatePaths = @()
    )

    $executable = Get-ExecutablePath -Commands $Commands -CandidatePaths $CandidatePaths
    if ([string]::IsNullOrWhiteSpace($executable)) {
        return ''
    }

    try {
        $job = Start-Job -ArgumentList $executable -ScriptBlock { param($exe) & $exe --get-id 2>$null }
        try {
            if (Wait-Job -Job $job -Timeout 10) {
                $output = [string](Receive-Job -Job $job -ErrorAction Stop | Select-Object -First 1)
                if ($output.Trim() -match '^\d[\d -]{4,30}$') { return ($output.Trim() -replace '[ -]', '') }
            }
        } finally {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        return ''
    } catch {
        return ''
    }
}

function Get-NetworkSnapshot {
    $section = @{ status = 'failed'; source = 'windows_cim'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); scope = 'enabled adapters, IPv4, routes and DNS' }
    $network = @{ wired_ip = ''; wireless_ip = ''; netbird_ip = ''; gateway = ''; dns = ''; interface_stats = @{} }
    try {
        $adapters = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -OperationTimeoutSec 15 -ErrorAction Stop)
        $dns = @()
        foreach ($adapter in $adapters) {
            $addresses = @($adapter.IPAddress | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            $description = [string]$adapter.Description
            $network.interface_stats[[string]$adapter.Index] = @{ name = $description; mac = [string]$adapter.MACAddress; addresses = $addresses; dhcp_enabled = [bool]$adapter.DHCPEnabled }
            if ($addresses.Count -gt 0) {
                $key = if ($description -match '(?i)netbird|wireguard|wt0') { 'netbird_ip' } elseif ($description -match '(?i)wireless|wi-fi|wifi|802.11') { 'wireless_ip' } else { 'wired_ip' }
                if (-not $network[$key]) { $network[$key] = $addresses[0] }
            }
            $gateways = @($adapter.DefaultIPGateway | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            if (-not $network.gateway -and $gateways.Count -gt 0) { $network.gateway = $gateways[0] }
            $dns += @($adapter.DNSServerSearchOrder)
        }
        $network.dns = (@($dns | Where-Object { $_ } | Sort-Object -Unique) -join ', ')
        $section.status = 'success'
        return @{ network = $network; section = $section }
    } catch {
        $section.error = 'network provider unavailable'
        return @{ network = $null; section = $section }
    }
}

function Get-InstalledSoftware {
    param([int]$Limit)
    $section = @{ status = 'failed'; source = 'registry,appx'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); error = 'software scan failed or timed out'; scope = 'machine and loaded user uninstall hives; all-user AppX; unloaded hives and portable apps excluded' }
    $scan = @{ apps = @(); section = $section }
    $job = $null
    try {
        $job = Start-Job -ArgumentList $Limit -ScriptBlock {
            param($bound)
            $ErrorActionPreference = 'Stop'
            $failed = $false
            function Test-DesktopRegistryApplication {
                param($App, $ShortcutTargets)
                if ($App.SystemComponent -eq 1 -or $App.ParentKeyName -or $App.ReleaseType) { return $false }
                $icon = [Environment]::ExpandEnvironmentVariables(([string]$App.DisplayIcon -replace ',\s*-?\d+$', '').Trim('"'))
                if ($icon -and $ShortcutTargets.Contains($icon)) { return $true }
                $location = [Environment]::ExpandEnvironmentVariables(([string]$App.InstallLocation).Trim('"').TrimEnd('\'))
                if (-not $location -or -not [IO.Path]::IsPathRooted($location) -or $location.Length -le 3) { return $false }
                if ($location -eq $env:ProgramFiles -or $location -eq ${env:ProgramFiles(x86)} -or $location -eq $env:windir) { return $false }
                foreach ($target in $ShortcutTargets) {
                    if ($target.StartsWith($location + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
                }
                return $false
            }
            function Test-DesktopAppxApplication {
                param($App, $Manifest)
                if ($App.IsFramework -or $App.IsResourcePackage -or $App.NonRemovable -or [string]$App.SignatureKind -eq 'System') { return $false }
                foreach ($entry in $Manifest.Package.Applications.Application) {
                    if ($entry.VisualElements -and $entry.VisualElements.AppListEntry -ne 'none') { return $true }
                }
                return $false
            }
            $shortcutRoots = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))
            $paths = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
            foreach ($hive in (Get-ChildItem 'Registry::HKEY_USERS')) {
                if ($hive.PSChildName -match '^S-1-5-21-[\d-]+$') {
                    $paths += ('Registry::' + $hive.Name + '\Software\Microsoft\Windows\CurrentVersion\Uninstall')
                    $paths += ('Registry::' + $hive.Name + '\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
                    try {
                        $profile = Get-ItemProperty -LiteralPath ('HKLM:\Software\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $hive.PSChildName)
                        $shortcutRoots += Join-Path ([Environment]::ExpandEnvironmentVariables($profile.ProfileImagePath)) 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
                    } catch { $failed = $true }
                }
            }
            $shortcutTargets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            try {
                $shell = New-Object -ComObject WScript.Shell
                foreach ($root in ($shortcutRoots | Sort-Object -Unique)) {
                    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
                    $links = @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse | Select-Object -First 2001)
                    if ($links.Count -gt 2000) { $failed = $true }
                    foreach ($link in ($links | Select-Object -First 2000)) {
                        $target = [string]$shell.CreateShortcut($link.FullName).TargetPath
                        if ($target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { [void]$shortcutTargets.Add($target) }
                    }
                }
            } catch { $failed = $true }
            $apps = @()
            foreach ($path in $paths) {
                try {
                    if (-not (Test-Path -LiteralPath $path)) { continue }
                    foreach ($key in (Get-ChildItem -LiteralPath $path)) {
                        $app = Get-ItemProperty -LiteralPath $key.PSPath
                        if ([string]::IsNullOrWhiteSpace([string]$app.DisplayName)) { continue }
                        $date = ''
                        $parsedDate = [datetime]::MinValue
                        if ([datetime]::TryParseExact([string]$app.InstallDate, 'yyyyMMdd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsedDate)) { $date = $parsedDate.ToString('yyyy-MM-dd') }
                        $source = if (Test-DesktopRegistryApplication $app $shortcutTargets) { 'registry_desktop' } else { 'registry' }
                        $apps += @{ name = [string]$app.DisplayName; version = [string]$app.DisplayVersion; install_date = $date; source = $source }
                    }
                } catch { $failed = $true }
            }
            try {
                foreach ($app in (Get-AppxPackage -AllUsers -ErrorAction Stop)) {
                    $source = 'appx'
                    if (-not ($app.IsFramework -or $app.IsResourcePackage -or $app.NonRemovable -or [string]$app.SignatureKind -eq 'System')) {
                        try {
                            $manifest = Get-AppxPackageManifest -Package $app.PackageFullName -ErrorAction Stop
                            if (Test-DesktopAppxApplication $app $manifest) { $source = 'appx_desktop' }
                        } catch { $failed = $true }
                    }
                    $apps += @{ name = [string]$app.Name; version = [string]$app.Version; install_date = ''; source = $source }
                }
            } catch { $failed = $true }
            $unique = @($apps | Sort-Object { $_.source }, { $_.name }, { $_.version } -Unique)
            @{ apps = @($unique | Select-Object -First $bound); total = $unique.Count; failed = $failed }
        }
        if (Wait-Job -Job $job -Timeout 120) {
            $result = Receive-Job -Job $job -ErrorAction Stop
            if ($job.State -eq 'Completed' -and $null -ne $result) {
                $scan.apps = @($result.apps)
                $section.status = 'success'
                $section.Remove('error')
                $section.total = $result.total
                $section.returned = $scan.apps.Count
                $section.truncated = ($result.total -gt $Limit)
                if ($section.truncated -or $result.failed) { $section.status = 'partial'; $section.error = 'coverage bounded or one source unavailable' }
            }
        }
    } catch {
    } finally {
        if ($null -ne $job) { Stop-Job -Job $job -ErrorAction SilentlyContinue; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    }
    return $scan
}

function Get-VolumeDetails {
    $bitLockerByMountPoint = @{}
    try {
        foreach ($entry in (Get-BitLockerVolume -ErrorAction Stop)) {
            $key = [string]$entry.MountPoint
            if (-not [string]::IsNullOrWhiteSpace($key)) {
                $bitLockerByMountPoint[$key.ToUpperInvariant()] = $entry
            }
        }
    } catch {
    }

    $volumeMap = @{}
    try {
        foreach ($volume in (Get-Volume -ErrorAction Stop)) {
            $key = [string]$volume.UniqueId
            if (-not [string]::IsNullOrWhiteSpace($key)) {
                $volumeMap[$key] = $volume
            }
        }
    } catch {
    }

    $results = @()
    try {
        foreach ($partition in (Get-Partition -ErrorAction Stop | Sort-Object DiskNumber, PartitionNumber)) {
            $driveLetter = [string]$partition.DriveLetter
            $mountPoint = if (-not [string]::IsNullOrWhiteSpace($driveLetter)) { "$driveLetter`:" } else { [string]$partition.AccessPaths | Select-Object -First 1 }
            $volume = $null
            try {
                $volume = Get-Volume -Partition $partition -ErrorAction Stop
            } catch {
            }
            $bitLocker = $null
            if (-not [string]::IsNullOrWhiteSpace($mountPoint)) {
                $bitLocker = $bitLockerByMountPoint[$mountPoint.ToUpperInvariant()]
            }

            $size = if ($partition.Size) { Format-Bytes -Bytes ([UInt64]$partition.Size) } else { '' }
            $available = if ($volume -and $volume.SizeRemaining) { Format-Bytes -Bytes ([UInt64]$volume.SizeRemaining) } else { '' }
            $usedPercent = ''
            if ($volume -and $volume.Size -and $volume.SizeRemaining -ge 0) {
                $used = [double]$volume.Size - [double]$volume.SizeRemaining
                if ($volume.Size -gt 0) {
                    $usedPercent = ('{0:N0}%%' -f (($used / [double]$volume.Size) * 100))
                }
            }

            $results += [ordered]@{
                name = if (-not [string]::IsNullOrWhiteSpace($mountPoint)) { $mountPoint } else { "Disk $($partition.DiskNumber) Partition $($partition.PartitionNumber)" }
                path = if (-not [string]::IsNullOrWhiteSpace($mountPoint)) { $mountPoint } else { "Disk $($partition.DiskNumber)" }
                size = $size
                filesystem = [string]($volume.FileSystem)
                device_type = 'partition'
                mountpoint = $mountPoint
                available = $available
                used_percent = $usedPercent
                uuid = [string]($volume.UniqueId)
                parent = "Disk $($partition.DiskNumber)"
                encrypted = [bool]($bitLocker -and $bitLocker.ProtectionStatus -eq 'On')
                encryption = if ($bitLocker) { [string]$bitLocker.VolumeStatus } else { '' }
            }
        }
    } catch {
    }

    return $results
}

function Get-DiskLayoutText {
    $parts = @()
    try {
        $parts += ((Get-Disk -ErrorAction Stop | Format-Table -AutoSize | Out-String).Trim())
    } catch {
    }
    try {
        $parts += ((Get-Partition -ErrorAction Stop | Format-Table -AutoSize | Out-String).Trim())
    } catch {
    }
    try {
        $parts += ((Get-Volume -ErrorAction Stop | Format-Table -AutoSize | Out-String).Trim())
    } catch {
    }

    return Truncate-Text -Value ($parts -join "`n`n")
}

function Get-ClamAvScannerPath {
    $command = Get-Command clamscan.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = @(
        'C:\Program Files\ClamWin\bin\clamscan.exe',
        'C:\Program Files (x86)\ClamWin\bin\clamscan.exe',
        'C:\Program Files\ClamAV\clamscan.exe',
        'C:\Program Files\ClamAV\clamdscan.exe'
    )

    return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Get-ParsedCount {
    param(
        [string]$Output,
        [string]$Label
    )

    $match = [regex]::Match($Output, ('(?im)^\s*' + [regex]::Escape($Label) + ':\s*(\d+)'))
    if ($match.Success) {
        return [int]$match.Groups[1].Value
    }
    return 0
}

function Get-ClamAvReport {
    $scanner = Get-ClamAvScannerPath
    if ([string]::IsNullOrWhiteSpace($scanner)) {
        return $null
    }

    $resolvedPaths = @($ClamAvScanPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path $_) })
    if (-not $resolvedPaths -or $resolvedPaths.Count -eq 0) {
        $resolvedPaths = @('C:\')
    }

    $arguments = @('--recursive', '--infected') + $resolvedPaths
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = $scanner
    $process.StartInfo.Arguments = [string]::Join(' ', ($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }))
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true

    [void]$process.Start()
    if (-not $process.WaitForExit($ClamAvTimeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        return [ordered]@{
            source = 'clamav'
            status = 'error'
            severity = 'warning'
            title = 'ClamAV scan failed'
            summary = 'ClamAV scan timed out before completion.'
            detail = 'The ClamAV scheduled scan exceeded the configured timeout.'
            scanned_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            scanned_paths = $resolvedPaths
            error_count = 1
        }
    }

    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $output = (($stdout, $stderr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n"
    $infectedFiles = @()
    foreach ($line in ($output -split "`r?`n")) {
        if ($line.Trim().EndsWith(' FOUND') -and $line.Contains(':')) {
            $infectedFiles += ($line.Substring(0, $line.LastIndexOf(':')).Trim())
        }
    }

    $infectedCount = Get-ParsedCount -Output $output -Label 'Infected files'
    if ($infectedCount -eq 0 -and $infectedFiles.Count -gt 0) {
        $infectedCount = $infectedFiles.Count
    }
    $scannedCount = Get-ParsedCount -Output $output -Label 'Scanned files'
    $errorCount = Get-ParsedCount -Output $output -Label 'Total errors'

    $status = 'clean'
    $severity = 'info'
    $title = 'ClamAV scan clean'
    if ($process.ExitCode -eq 1 -or $infectedCount -gt 0) {
        $status = 'infected'
        $severity = 'high'
        $title = 'ClamAV detected threats'
    } elseif ($process.ExitCode -ne 0) {
        $status = 'error'
        $severity = 'warning'
        $title = 'ClamAV scan failed'
    }

    $detailLines = @($output -split "`r?`n" | Select-Object -Last 40)

    return [ordered]@{
        source = 'clamav'
        status = $status
        severity = $severity
        title = $title
        summary = ('Scanned {0} files; infected: {1}; errors: {2}.' -f $(if ($scannedCount -gt 0) { $scannedCount } else { 'unknown' }), $infectedCount, $errorCount)
        detail = ($detailLines -join "`n").Trim()
        scanned_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        scanned_paths = $resolvedPaths
        infected_files = @($infectedFiles | Select-Object -First 20)
        scanned_file_count = $scannedCount
        infected_file_count = $infectedCount
        error_count = $errorCount
    }
}

function Get-InferredCategory {
    param(
        [string]$RequestedCategory,
        [string]$Manufacturer,
        [string]$Model,
        [int]$PcSystemType
    )

    $normalized = ([string]$RequestedCategory).Trim().ToLowerInvariant()
    if ($normalized -and $normalized -ne 'auto') {
        return $normalized
    }

    $combined = ($Manufacturer + ' ' + $Model).ToLowerInvariant()
    if ($combined -match 'virtual|vmware|virtualbox|hyper-v|kvm|qemu') {
        return 'vm'
    }

    if ($PcSystemType -eq 2) {
        return 'laptop'
    }

    return 'desktop'
}

function Get-DetectedSaltMinionId {
    $paths = @(
        'C:\salt\conf\minion_id',
        'C:\ProgramData\Salt Project\Salt\conf\minion_id'
    )

    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) {
            $value = (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                return $value
            }
        }
    }

    return ''
}

function Get-DetectedWazuhAgentId {
    $paths = @(
        'C:\Program Files (x86)\ossec-agent\client.keys',
        'C:\Program Files\ossec-agent\client.keys'
    )

    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) {
            $line = (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            $parts = $line -split '\s+'
            if ($parts.Length -ge 2 -and -not [string]::IsNullOrWhiteSpace($parts[1])) {
                return $parts[1]
            }
        }
    }

    return ''
}

function Get-SourceFingerprint {
    if (-not [string]::IsNullOrWhiteSpace($SourceFingerprint)) {
        return $SourceFingerprint.Trim().ToLowerInvariant()
    }

    try {
        $machineGuid = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name 'MachineGuid' -ErrorAction Stop).MachineGuid
        if (-not [string]::IsNullOrWhiteSpace($machineGuid)) {
            return $machineGuid.Trim().ToLowerInvariant()
        }
    } catch {
    }

    if (-not [string]::IsNullOrWhiteSpace($bios.SerialNumber)) {
        return $bios.SerialNumber.Trim().ToLowerInvariant()
    }

    return $env:COMPUTERNAME.Trim().ToLowerInvariant()
}

function Get-DefaultAssetTag {
    param(
        [string]$Hostname,
        [string]$Fingerprint
    )

    $hostnameKey = -join (($Hostname.ToUpperInvariant().ToCharArray() | Where-Object { [char]::IsLetterOrDigit($_) }))
    if ([string]::IsNullOrWhiteSpace($hostnameKey)) {
        $hostnameKey = 'SYSTEM'
    }

    $suffix = -join (($Fingerprint.ToUpperInvariant().ToCharArray() | Where-Object { [char]::IsLetterOrDigit($_) }))
    if ($suffix.Length -gt 8) {
        $suffix = $suffix.Substring(0, 8)
    }

    if ([string]::IsNullOrWhiteSpace($suffix)) {
        if ($hostnameKey.Length -gt 20) {
            return $hostnameKey.Substring(0, 20)
        }
        return $hostnameKey
    }

    $prefixLength = 20 - $suffix.Length - 1
    if ($prefixLength -lt 1) {
        $prefixLength = 1
    }
    if ($hostnameKey.Length -gt $prefixLength) {
        $hostnameKey = $hostnameKey.Substring(0, $prefixLength)
    }
    return $hostnameKey + '-' + $suffix
}

if ($HeartbeatOnly -or $HeartbeatLoop) {
    if ([string]::IsNullOrWhiteSpace($AssetTag)) {
        $bios = Get-CimInstance Win32_BIOS
        $AssetTag = Get-DefaultAssetTag -Hostname $env:COMPUTERNAME -Fingerprint (Get-SourceFingerprint)
    }
    $heartbeatJson = @{ asset_tag = $AssetTag } | ConvertTo-Json -Compress
    if ($PrintOnly) { $heartbeatJson; exit 0 }
    if ([string]::IsNullOrWhiteSpace($Token)) { throw 'Heartbeat requires the configured ingest token.' }
    $heartbeatEndpoint = (Normalize-Endpoint -Value $ServerUrl) -replace '/inventory-sync/ingest$', '/assets/heartbeat'
    do {
        $heartbeatStarted = [DateTime]::UtcNow
        try {
            $null = Invoke-RestMethod -Uri $heartbeatEndpoint -Method Put -ContentType 'application/json' -Headers @{ Authorization = ('Bearer ' + $Token) } -Body $heartbeatJson -TimeoutSec 10 -MaximumRedirection 0
        } catch {
            [Console]::Error.WriteLine('Heartbeat failed; waiting for the next scheduled check.')
            if (-not $HeartbeatLoop) { exit 1 }
        }
        if ($HeartbeatLoop) {
            $remaining = [Math]::Max(1, 30 - ([DateTime]::UtcNow - $heartbeatStarted).TotalSeconds)
            Start-Sleep -Milliseconds ([int]($remaining * 1000))
        }
    } while ($HeartbeatLoop)
    exit 0
}

$computer = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$processor = Get-CimInstance Win32_Processor | Select-Object -First 1
$videoControllers = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
$memory = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum
$storage = (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Measure-Object -Property Size -Sum).Sum
$hostname = $env:COMPUTERNAME
$endpoint = Normalize-Endpoint -Value $ServerUrl
$resolvedCategory = Get-InferredCategory -RequestedCategory $Category -Manufacturer $computer.Manufacturer -Model $computer.Model -PcSystemType ([int]$computer.PCSystemType)
$resolvedSourceFingerprint = Get-SourceFingerprint

if ([string]::IsNullOrWhiteSpace($AssetTag)) {
    $AssetTag = Get-DefaultAssetTag -Hostname $hostname -Fingerprint $resolvedSourceFingerprint
}
if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = $hostname
}
if ([string]::IsNullOrWhiteSpace($SaltMinionId)) {
    $SaltMinionId = Get-DetectedSaltMinionId
}
if ([string]::IsNullOrWhiteSpace($WazuhAgentId)) {
    $WazuhAgentId = Get-DetectedWazuhAgentId
}

$securityReports = @()
if ($IncludeClamAvReport -and -not $InventoryOnly) {
    $clamAvReport = Get-ClamAvReport
    if ($clamAvReport) {
        $securityReports += $clamAvReport
    }
}

$updateScan = Get-UpdateScan
$networkScan = Get-NetworkSnapshot
$softwareScan = @{ apps = @(); section = @{ status = 'uncollected'; source = 'none'; scanned_at = (Get-Date).ToUniversalTime().ToString('o') } }
if (-not $NoSoftwareScan) { $softwareScan = Get-InstalledSoftware -Limit $SoftwareLimit }
$serviceScan = Get-ServiceScan -Limit $ServiceLimit

$payload = [ordered]@{
    assets = @(
        [ordered]@{
            asset_tag = $AssetTag
            name = $Name
            hostname = $hostname
            category = $resolvedCategory
            is_compute = $true
            serial_number = $bios.SerialNumber
            manufacturer = $computer.Manufacturer
            model = $computer.Model
            entity_id = $EntityId
            dept_id = $DeptId
            location_id = $LocationId
            assigned_to_email = $AssignedToEmail
            assigned_to_name = $AssignedToName
            employee_code = $EmployeeCode
            department_name = $DepartmentName
            purchase_date = $PurchaseDate
            warranty_until = $WarrantyUntil
            status = $Status
            condition = $Condition
            source_fingerprint = $resolvedSourceFingerprint
            salt_minion_id = $SaltMinionId
            wazuh_agent_id = $WazuhAgentId
            notes = $Notes
            compute_details = [ordered]@{
                processor = $processor.Name
                ram = (Format-Bytes -Bytes ([UInt64]$memory))
                storage = (Format-Bytes -Bytes ([UInt64]$storage))
                gpu = $(if ($UseDetailedHardwareInventory) { Get-GpuDescription } else { '' })
                display = $(if ($UseDetailedHardwareInventory) { Get-DisplayDescription } else { '' })
                bios_version = $bios.SMBIOSBIOSVersion
                mac_address = $(if ($UseDetailedHardwareInventory) { Get-PrimaryMacAddress } else { '' })
                os_name = $operatingSystem.Caption
                os_version = $operatingSystem.Version
                kernel = $operatingSystem.BuildNumber
                architecture = $operatingSystem.OSArchitecture
                os_build = $operatingSystem.BuildNumber
                last_boot = $(if ($UseDetailedHardwareInventory) { Format-UtcTimestamp -Value $operatingSystem.LastBootUpTime } else { '' })
                last_seen = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                logged_in_users = (Get-LoggedInUsers)
                pending_updates = $updateScan.count
                pending_update_details = @($updateScan.details)
                reboot_required = $updateScan.reboot
                anydesk_id = (Get-RemoteAccessId -Commands @('AnyDesk.exe', 'anydesk.exe') -CandidatePaths @('C:\Program Files (x86)\AnyDesk\AnyDesk.exe', 'C:\Program Files\AnyDesk\AnyDesk.exe'))
                rustdesk_id = (Get-RemoteAccessId -Commands @('rustdesk.exe', 'RustDesk.exe') -CandidatePaths @('C:\Program Files\RustDesk\rustdesk.exe', 'C:\Program Files (x86)\RustDesk\rustdesk.exe'))
                disk_layout = (Get-DiskLayoutText)
                volumes = (Get-VolumeDetails)
            }
            installed_software = @($softwareScan.apps)
            services = @($serviceScan.services)
            network = $networkScan.network
            collection_status = @{ software = $softwareScan.section; updates = $updateScan.section; network = $networkScan.section; services = $serviceScan.section }
            security_reports = $securityReports
        }
    )
}

$hardware = $payload.assets[0].compute_details
$hardwareStatus = 'partial' # Optional CIM helpers suppress failures; completeness is unverified.
$payload.assets[0].collection_status.hardware = @{ status = $hardwareStatus; source = 'windows_cim'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); scope = 'best-effort CIM hardware fields; optional provider completion unverified' }
$payload.assets[0].collection_status.remote_access = @{ status = $(if ($hardware.anydesk_id -or $hardware.rustdesk_id) { 'partial' } else { 'uncollected' }); source = 'installed_executable_get_id'; scanned_at = (Get-Date).ToUniversalTime().ToString('o'); scope = 'numeric local IDs only; unavailable IDs are not passwords' }

if ($PrintOnly) {
    $payload | ConvertTo-Json -Depth 8
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Error 'ITMS ingest token is required. Set ITMS_INGEST_TOKEN, use -TokenFile, use -PromptToken, or rely on C:\ProgramData\ITMS\itms-agent.env.'
    exit 1
}

$json = $payload | ConvertTo-Json -Depth 8
$headers = @{ Authorization = ('Bearer ' + $Token) }

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType 'application/json' -Headers $headers -Body $json -TimeoutSec $TimeoutSeconds
    $response | ConvertTo-Json -Depth 8
} catch {
    Write-Error $_
    exit 1
}