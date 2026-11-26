"""Mocked collector tests: no host commands, configuration or service files read."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, mock_open, patch

from test_push_system_inventory import COLLECTOR, MODULE_PATH


class ServiceInventoryTest(unittest.TestCase):
    def test_desktop_metadata_excludes_libraries_hidden_and_system_tools(self):
        desktop = "[Desktop Entry]\nType=Application\nName=Browser\nExec=browser %U\nCategories=Network;WebBrowser;\n"
        self.assertEqual(COLLECTOR.desktop_entry_metadata(desktop)["Name"], "Browser")
        for suffix in ("NoDisplay=true\n", "Hidden=true\n", "Categories=System;\n", "Categories=Settings;\n"):
            self.assertIsNone(COLLECTOR.desktop_entry_metadata(desktop + suffix))
        self.assertIsNone(COLLECTOR.desktop_entry_metadata("[Desktop Entry]\nType=Link\nName=Library\n"))
        self.assertIsNone(COLLECTOR.desktop_entry_metadata("broken"))

    def test_desktop_classification_requires_registration_not_package_name(self):
        rows = [{"name": "google-chrome-stable", "source": "dpkg"},
                {"name": "libchrome", "source": "dpkg"},
                {"name": "org.mozilla.firefox", "source": "flatpak"},
                {"name": "unregistered-browser", "source": "snap"}]
        with patch.object(COLLECTOR.os, "scandir", side_effect=FileNotFoundError):
            self.assertEqual(COLLECTOR.classify_linux_desktop_software(rows), [])
        self.assertEqual([row["source"] for row in rows], ["dpkg", "dpkg", "flatpak", "snap"])

    def test_linux_desktop_package_ownership_and_snap_evidence(self):
        directory = MagicMock()
        directory.__enter__.return_value = [SimpleNamespace(name="browser.desktop", path="/usr/share/applications/browser.desktop")]
        desktop = "[Desktop Entry]\nType=Application\nName=Browser\nExec=browser %U\nX-SnapInstanceName=browser\nX-Flatpak=org.example.Browser\n"
        for provider, package, output in [("dpkg-query", "browser:amd64", "browser:amd64: /usr/share/applications/browser.desktop"),
                                          ("rpm", "browser", "browser")]:
            rows = [{"name": package, "source": "dpkg" if provider == "dpkg-query" else "rpm"},
                    {"name": "libbrowser", "source": "dpkg"}, {"name": "browser", "source": "snap"},
                    {"name": "org.example.Browser", "source": "flatpak"}]
            with patch.object(COLLECTOR.os, "scandir", return_value=directory), \
                    patch.object(COLLECTOR.Path, "open", mock_open(read_data=desktop)), \
                    patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == provider), \
                    patch.object(COLLECTOR, "scan_command", return_value=(output, "")) as query:
                self.assertEqual(COLLECTOR.classify_linux_desktop_software(rows), [])
                self.assertEqual(rows[0]["source"], "dpkg_desktop" if provider == "dpkg-query" else "rpm_desktop")
                self.assertEqual(rows[1]["source"], "dpkg")
                self.assertEqual(rows[2]["source"], "snap_desktop")
                self.assertEqual(rows[3]["source"], "flatpak_desktop")
                self.assertEqual(query.call_args.kwargs["valid_codes"], (0, 1))
                self.assertLessEqual(query.call_args.kwargs["timeout"], 10)

    def test_windows_desktop_registration_does_not_replace_raw_inventory(self):
        text = MODULE_PATH.with_suffix(".ps1").read_text()
        for marker in ("Test-DesktopRegistryApplication", "$App.SystemComponent", "$App.ParentKeyName", "$App.ReleaseType",
                       "$ShortcutTargets.Contains($icon)", "$App.IsFramework", "$App.IsResourcePackage", "$App.NonRemovable",
                       "AppListEntry -ne 'none'", "'registry_desktop'", "'appx_desktop'", "Select-Object -First 2001"):
            self.assertIn(marker, text)

    def test_macos_marks_third_party_bundles_but_not_apple_apps(self):
        directory = MagicMock()
        directory.__enter__.return_value = [SimpleNamespace(name="Browser.app", path="/Applications/Browser.app")]
        for identifier, expected in [("org.example.Browser", "app_bundle_desktop"), ("com.apple.Safari", "app_bundle"), ("", "app_bundle")]:
            with patch.object(COLLECTOR, "is_macos", return_value=True), \
                    patch.object(COLLECTOR, "brew_executable", return_value=None), \
                    patch.object(COLLECTOR, "command_exists", return_value=False), \
                    patch.object(COLLECTOR.os, "scandir", side_effect=[directory, FileNotFoundError, FileNotFoundError]), \
                    patch.object(COLLECTOR.Path, "open", mock_open(read_data=b"")), \
                    patch.object(COLLECTOR.plistlib, "load", return_value={"CFBundleName": "Browser", "CFBundleIdentifier": identifier}):
                rows, status = COLLECTOR.collect_software_scan()
                self.assertEqual(status["status"], "success")
                self.assertEqual(rows[0]["source"], expected)

    def setUp(self):
        for target, name, options in (
            (COLLECTOR.subprocess, "run", {"side_effect": AssertionError("unmocked command")}),
            (COLLECTOR.urllib.request, "urlopen", {"side_effect": AssertionError("unmocked network")}),
            (COLLECTOR, "read_text", {"side_effect": AssertionError("unmocked host file")}),
            (COLLECTOR, "env_file_value", {"side_effect": AssertionError("unmocked configuration")}),
            (COLLECTOR, "scan_command", {"return_value": ("", "")}),
            (COLLECTOR, "command_exists", {"return_value": True}),
            (COLLECTOR, "is_macos", {"return_value": False}),
            (COLLECTOR.platform, "system", {"return_value": "Linux"}),
            (COLLECTOR.os, "geteuid", {"return_value": 0}),
        ):
            mocker = patch.object(target, name, **options)
            mocker.start()
            self.addCleanup(mocker.stop)

    def test_linux_discovers_disabled_and_runtime_only_units(self):
        COLLECTOR.scan_command.side_effect = [
            ("ssh.service enabled enabled\nold.service disabled disabled\nmask.service masked enabled", ""),
            ("ssh.service loaded active running SSH\nold.service loaded inactive dead Old\ntransient.service loaded failed failed Hidden command description", ""),
        ]
        rows, status = COLLECTOR.collect_service_scan()
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(status["status"], "success")
        self.assertEqual(by_name["old.service"]["start_mode"], "disabled")
        self.assertEqual(by_name["old.service"]["state"], "inactive/dead")
        self.assertEqual(by_name["mask.service"]["state"], "unknown")
        self.assertEqual(by_name["transient.service"]["state"], "failed/failed")
        self.assertNotIn("Hidden", str(rows))
        commands = [call.args[0] for call in COLLECTOR.scan_command.call_args_list]
        self.assertIn("list-unit-files", commands[0])
        self.assertIn("--all", commands[1])
        self.assertTrue(all("--full" in command for command in commands))
        self.assertTrue(all(set(row) == {"name", "display_name", "state", "start_mode", "source"} for row in rows))

    def test_linux_one_failed_query_is_partial_not_authoritative(self):
        for outputs in [
            [("", "secret exception"), ("ssh.service loaded active running SSH", "")],
            [("ssh.service enabled", ""), ("", "secret exception")],
        ]:
            COLLECTOR.scan_command.side_effect = outputs
            rows, status = COLLECTOR.collect_service_scan()
            self.assertEqual(len(rows), 1)
            self.assertEqual(status["status"], "partial")
            self.assertNotIn("secret", str(status))

    def test_empty_success_and_failure_are_distinct(self):
        for error, expected in [("", "success"), ("timeout", "failed")]:
            COLLECTOR.scan_command.return_value = ("", error)
            rows, status = COLLECTOR.collect_service_scan()
            self.assertEqual(rows, [])
            self.assertEqual(status["status"], expected)

    def test_unrecognized_response_not_clean(self):
        COLLECTOR.scan_command.return_value = ("unexpected output", "")
        self.assertEqual(COLLECTOR.collect_service_scan()[1]["status"], "failed")

    def test_absent_systemd_unsupported(self):
        COLLECTOR.command_exists.return_value = False
        self.assertEqual(COLLECTOR.collect_service_scan()[1]["status"], "unsupported")
        COLLECTOR.scan_command.assert_not_called()

    def test_service_identity_never_silently_shortened(self):
        for name in ("a" * 257 + ".service", "bad\x00.service"):
            with self.subTest(name=name):
                COLLECTOR.scan_command.side_effect = [(name + " enabled", ""), ("", "")]
                rows, status = COLLECTOR.collect_service_scan()
                self.assertEqual(rows, [])
                self.assertEqual(status["status"], "failed")
                self.assertNotIn(name, status["error"])

    def test_mixed_valid_invalid_services_are_partial(self):
        COLLECTOR.scan_command.side_effect = [("ssh.service enabled\nunrecognized", ""), ("", "")]
        rows, status = COLLECTOR.collect_service_scan()
        self.assertEqual(len(rows), 1)
        self.assertEqual(status["status"], "partial")

    def test_other_os_unsupported(self):
        COLLECTOR.platform.system.return_value = "FreeBSD"
        self.assertEqual(COLLECTOR.collect_service_scan()[1]["status"], "unsupported")
        COLLECTOR.scan_command.assert_not_called()

    def test_bounds_and_truncation_count(self):
        files = "\n".join("s%05d.service disabled" % i for i in range(10001))
        for limit, expected in [(5000, 5000), (20000, 10000), (0, 1)]:
            COLLECTOR.scan_command.side_effect = [(files, ""), ("", "")]
            rows, status = COLLECTOR.collect_service_scan(limit)
            self.assertEqual(len(rows), expected)
            self.assertEqual(status["total"], 10001)
            self.assertEqual(status["returned"], expected)
            self.assertEqual(status["truncated_count"], 10001 - expected)
            self.assertEqual(status["status"], "partial")

    def test_macos_loaded_scope_running_and_stopped(self):
        COLLECTOR.is_macos.return_value = True
        COLLECTOR.scan_command.return_value = ("PID\tStatus\tLabel\n12\t0\tcom.test.active\n-\t0\tcom.test.stopped", "")
        rows, status = COLLECTOR.collect_service_scan()
        self.assertEqual([row["state"] for row in rows], ["running", "stopped"])
        self.assertEqual(status["status"], "success")
        self.assertIn("unloaded jobs and user domains excluded", status["scope"])
        self.assertTrue(all(row["start_mode"] == "unknown" for row in rows))
        COLLECTOR.scan_command.assert_called_once_with(["launchctl", "list"])

    def test_macos_nonroot_never_mislabeled_system_scope(self):
        COLLECTOR.is_macos.return_value = True
        COLLECTOR.os.geteuid.return_value = 501
        self.assertEqual(COLLECTOR.collect_service_scan()[1]["status"], "unsupported")
        COLLECTOR.scan_command.assert_not_called()

    def test_macos_empty_malformed_and_failure(self):
        COLLECTOR.is_macos.return_value = True
        for response, expected in [(("PID Status Label", ""), "success"),
                                   (("bad", ""), "failed"), (("", "timeout"), "failed")]:
            COLLECTOR.scan_command.return_value = response
            self.assertEqual(COLLECTOR.collect_service_scan()[1]["status"], expected)

    def test_payload_wires_services_independent_of_software(self):
        # Replace every collector before building a full payload.
        names = [name for name in vars(COLLECTOR) if name.startswith("collect_")]
        mocks = {}
        for name in names:
            mocker = patch.object(COLLECTOR, name, return_value="")
            mocks[name] = mocker.start()
            self.addCleanup(mocker.stop)
        mocks["collect_os_details"].return_value = ("Linux", "1", "1", "x64", "1")
        mocks["collect_network_details"].return_value = {}
        mocks["collect_update_scan"].return_value = (None, [], None, {"status": "failed"})
        rows = [{"name": "ssh.service", "source": "systemd"}]
        mocks["collect_service_scan"].return_value = (rows, {"status": "success"})
        with patch.object(COLLECTOR.os, "environ", {}), patch.object(COLLECTOR.sys, "argv", ["collector"]):
            args = COLLECTOR.parse_args()
        args.no_software_scan = True
        args.category = "desktop"
        payload = COLLECTOR.build_asset_payload(args)["assets"][0]
        self.assertEqual(payload["services"], rows)
        self.assertEqual(payload["collection_status"]["services"]["status"], "success")
        self.assertEqual(payload["collection_status"]["software"]["status"], "uncollected")
        self.assertEqual(payload["collection_status"]["hardware"]["status"], "partial")
        self.assertEqual(payload["collection_status"]["network"]["status"], "partial")
        mocks["collect_service_scan"].assert_called_once_with(5000)
        mocks["collect_software_scan"].assert_not_called()


class ServiceInstallerStaticTest(unittest.TestCase):
    def test_routine_inventory_is_separate_from_security_scans(self):
        root = MODULE_PATH.parent
        for installer in ("install-itms-agent.sh", "install-itms-agent-macos.sh"):
            self.assertIn("--software-limit 5000 --inventory-only", (root / installer).read_text())
        windows = (root / "install-itms-agent.ps1").read_text()
        self.assertIn("-SoftwareLimit 5000 -InventoryOnly", windows)
        self.assertIn("-SoftwareLimit 5000 -IncludeClamAvReport", windows)
        self.assertIn("if ($IncludeClamAvReport -and -not $InventoryOnly)", MODULE_PATH.with_suffix(".ps1").read_text())

    def test_windows_ssh_options_are_paired_and_public_key_only(self):
        windows = (MODULE_PATH.parent / "install-itms-agent.ps1").read_text()
        self.assertIn("[string]$SshUser", windows)
        self.assertIn("[string]$AuthorizedKey", windows)
        self.assertIn("if ($hasUser -ne $hasKey)", windows)
        self.assertIn("'^ssh-(ed25519|rsa) [A-Za-z0-9+/]+={0,3}$'", windows)
        main = windows.split("function Main {")[1]
        self.assertLess(main.index("Assert-SshOptions"), main.index("Resolve-IngestToken"))
        self.assertIn("Install-SshAccess", main)

    def test_windows_ssh_provisioning_preserves_ports_and_requires_key_auth(self):
        windows = (MODULE_PATH.parent / "install-itms-agent.ps1").read_text()
        ssh = windows.split("function Install-SshAccess {")[1].split("function Write-Config {")[0]
        for value in ("Get-WindowsCapability", "-PasswordNeverExpires -UserMayNotChangePassword",
                      "ITMS SSH account must not be an administrator", "AuthenticationMethods publickey",
                      "PasswordAuthentication no", "AllowTcpForwarding no", "SetAccessRuleProtection($true, $false)",
                      "& $sshd -t -f $candidate", "& $sshd -T", "-RemoteAddress $serverAddress",
                      "Existing managed SSH key differs", ".itms-backup-", "ReparsePoint"):
            self.assertIn(value, ssh)
        self.assertIn("Add-LocalGroupMember -SID 'S-1-5-32-545'", ssh)
        self.assertNotIn("Add-LocalGroupMember -SID 'S-1-5-32-544'", ssh)
        self.assertNotIn("Port 22", ssh)
        self.assertIn('$original + "`n" + $block + "`n"', ssh)

    def test_heartbeat_schedules_are_separate_and_bounded(self):
        root = MODULE_PATH.parent
        linux = (root / "install-itms-agent.sh").read_text()
        mac = (root / "install-itms-agent-macos.sh").read_text()
        windows = (root / "install-itms-agent.ps1").read_text()
        collector = MODULE_PATH.with_suffix(".ps1").read_text()
        for value in ("OnUnitActiveSec=30s", "AccuracySec=1s", "TimeoutStartSec=20", "--heartbeat-only", "enable --now itms-heartbeat.timer"):
            self.assertIn(value, linux)
        for value in ('"StartInterval": 30', '"RunAtLoad": True', '"--heartbeat-only"', "launchctl bootstrap system"):
            self.assertIn(value, mac)
        for value in ("-HeartbeatLoop", "-MultipleInstances IgnoreNew", "-AtStartup", "-RepetitionInterval (New-TimeSpan -Minutes 1)", "-AllowStartIfOnBatteries", "-ExecutionTimeLimit ([TimeSpan]::Zero)"):
            self.assertIn(value, windows)
        heartbeat = collector.split("if ($HeartbeatOnly -or $HeartbeatLoop) {")[1].split("$computer = Get-CimInstance Win32_ComputerSystem")[0]
        for value in ("-Method Put", "-TimeoutSec 10", "-MaximumRedirection 0", "30 -", "exit 0"):
            self.assertIn(value, heartbeat)
        for value in ("Get-UpdateScan", "Get-InstalledSoftware", "Get-ServiceScan", "Get-ClamAvReport", "Write-Error $_"):
            self.assertNotIn(value, heartbeat)

    def test_explicit_collector_url_wins_over_adjacent_copy(self):
        root = MODULE_PATH.parent
        linux = (root / "install-itms-agent.sh").read_text()
        win = (root / "install-itms-agent.ps1").read_text()
        self.assertIn('if [[ -z "$COLLECTOR_URL" && -n "$COLLECTOR_SOURCE_DEFAULT"', linux)
        self.assertIn('if ([string]::IsNullOrWhiteSpace($CollectorUrl) -and (Test-Path -LiteralPath $localCollector))', win)

    def test_windows_safe_projection_timeout_and_payload(self):
        text = MODULE_PATH.with_suffix(".ps1").read_text()
        function = text.split("function Get-ServiceScan {")[1].split("function Get-LoggedInUsers")[0]
        self.assertIn("-Property Name,DisplayName,State,StartMode", function)
        self.assertIn("-Timeout 60", function)
        self.assertIn("Remove-Job", function)
        self.assertIn("truncated_count", function)
        self.assertIn("if ($result.invalid)", function)
        self.assertIn("$name.Length -gt 256", function)
        self.assertNotIn("name = $name.Substring", function)
        self.assertNotIn("$_.PathName", function)
        self.assertNotIn("$_.StartName", function)
        self.assertIn("services = @($serviceScan.services)", text)
        self.assertIn("services = $serviceScan.section", text)
        self.assertIn("$ServiceLimit = 5000", text)

    def test_installer_schedules_and_initial_upload(self):
        root = MODULE_PATH.parent
        linux = (root / "install-itms-agent.sh").read_text()
        mac = (root / "install-itms-agent-macos.sh").read_text()
        win = (root / "install-itms-agent.ps1").read_text()
        for text in [linux, mac]:
            self.assertIn('REFRESH_HOURS="6"', text)
            self.assertIn("Pushing initial inventory snapshot", text)
        self.assertIn("OnUnitActiveSec=${REFRESH_HOURS}h", linux)
        self.assertIn("<key>RunAtLoad</key><true/>", mac)
        self.assertIn("<key>StartInterval</key><integer>$interval</integer>", mac)
        self.assertIn("launchctl bootstrap system", mac)
        self.assertIn("[int]$RefreshHours = 6", win)
        self.assertIn("/SC HOURLY /MO $RefreshHours /RU SYSTEM", win)
        self.assertIn("[bool]$UseDetailedHardwareInventory = $true", win)
        self.assertIn("Invoke-InitialInventoryPush", win)
        self.assertIn("[ValidateRange(1, 23)]", win)
        self.assertIn("throw 'Inventory refresh task creation failed.'", win)
        self.assertIn("throw 'ClamAV inventory task creation failed.'", win)


if __name__ == "__main__":
    unittest.main()