#!/usr/bin/env python3

import importlib.util
import io
import json
import subprocess
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).with_name("push-system-inventory.py")
SPEC = importlib.util.spec_from_file_location("push_system_inventory", MODULE_PATH)
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)


class HeartbeatTest(unittest.TestCase):
    def test_inventory_only_overrides_security_flags_without_skipping_inventory(self):
        with patch.object(COLLECTOR.os, "environ", {}), \
                patch.object(COLLECTOR, "env_file_value", return_value=""), \
                patch.object(COLLECTOR.sys, "argv", ["collector", "--inventory-only", "--print-only", "--include-clamav-report", "--include-cve-report", "--include-openscap-report"]), \
                patch.object(COLLECTOR.sys, "stdout", new_callable=io.StringIO), \
                patch.object(COLLECTOR, "build_asset_payload", return_value={"assets": []}) as build:
            self.assertEqual(COLLECTOR.main(), 0)
            args = build.call_args.args[0]
            self.assertFalse(args.include_clamav_report)
            self.assertFalse(args.include_cve_report)
            self.assertFalse(args.include_openscap_report)
            self.assertFalse(args.no_software_scan)

    def test_heartbeat_skips_inventory(self):
        args = types.SimpleNamespace(heartbeat_only=True, token_file="", prompt_token=False)
        with patch.object(COLLECTOR, "env_file_value", return_value=""), \
                patch.object(COLLECTOR, "parse_args", return_value=args), \
                patch.object(COLLECTOR, "send_heartbeat", return_value=0) as heartbeat, \
                patch.object(COLLECTOR, "build_asset_payload", side_effect=AssertionError("inventory scan")):
            self.assertEqual(COLLECTOR.main(), 0)
            heartbeat.assert_called_once()

    def test_small_authenticated_request_and_no_redirects(self):
        args = types.SimpleNamespace(asset_tag="DEVICE-1", source_fingerprint="", print_only=False,
                                     server_url="https://itms.example.test/api/inventory-sync/ingest?ignored=true#ignored")
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(COLLECTOR, "collect_hostname", return_value="device"), \
                patch.object(COLLECTOR, "collect_source_fingerprint", side_effect=AssertionError("unneeded identity lookup")), \
                patch.object(COLLECTOR.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(COLLECTOR.send_heartbeat(args, "synthetic"), 0)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://itms.example.test/api/assets/heartbeat")
            self.assertEqual(request.method, "PUT")
            self.assertEqual(json.loads(request.data), {"asset_tag": "DEVICE-1"})
            self.assertEqual(request.get_header("Authorization"), "Bearer synthetic")
            self.assertEqual(opener.return_value.open.call_args.kwargs, {"timeout": 10})
            handler = opener.call_args.args[0]()
            self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://other.test"))

    def test_failure_does_not_log_credentials_or_retry(self):
        args = types.SimpleNamespace(asset_tag="DEVICE-1", print_only=False, server_url="https://itms.example.test")
        with patch.object(COLLECTOR, "collect_hostname", return_value="device"), \
                patch.object(COLLECTOR.urllib.request, "build_opener") as opener, \
                patch.object(COLLECTOR.sys, "stderr", new_callable=io.StringIO) as errors:
            opener.return_value.open.side_effect = COLLECTOR.urllib.error.URLError("synthetic-secret")
            self.assertEqual(COLLECTOR.send_heartbeat(args, "synthetic-secret"), 1)
            self.assertNotIn("synthetic-secret", errors.getvalue())
            opener.return_value.open.assert_called_once()


class TrivyReportTest(unittest.TestCase):
    def test_parse_trivy_report_summarizes_findings(self):
        payload = {
            "Results": [
                {
                    "Vulnerabilities": [
                        {
                            "VulnerabilityID": "CVE-2026-0001",
                            "PkgName": "example-lib",
                            "InstalledVersion": "1.0",
                            "FixedVersion": "1.1",
                            "Severity": "HIGH",
                        },
                        {
                            "VulnerabilityID": "CVE-2026-0002",
                            "PkgName": "example-cli",
                            "InstalledVersion": "2.0",
                            "FixedVersion": "",
                            "Severity": "MEDIUM",
                        },
                    ]
                }
            ]
        }

        report = COLLECTOR.parse_trivy_report(payload, "2026-08-11T10:00:00Z")

        self.assertEqual(report["source"], "cve")
        self.assertEqual(report["status"], "vulnerable")
        self.assertEqual(report["severity"], "high")
        self.assertEqual(report["scanned_file_count"], 2)
        self.assertIn("high: 1", report["summary"])
        self.assertIn("CVE-2026-0001 [HIGH] example-lib 1.0 (fixed: 1.1)", report["detail"])


class MacOSCollectionTest(unittest.TestCase):
    @patch.object(COLLECTOR, "run_command")
    @patch.object(COLLECTOR, "is_macos", return_value=True)
    def test_collects_macos_os_details(self, _is_macos, run_command):
        responses = {
            ("sw_vers", "-productName"): "macOS",
            ("sw_vers", "-productVersion"): "15.6",
            ("sw_vers", "-buildVersion"): "24G84",
        }
        run_command.side_effect = lambda command, timeout=15: responses.get(tuple(command), "")

        os_name, os_version, _kernel, _architecture, os_build = COLLECTOR.collect_os_details()

        self.assertEqual(os_name, "macOS 15.6")
        self.assertEqual(os_version, "15.6")
        self.assertEqual(os_build, "24G84")

    @patch.object(COLLECTOR, "scan_command")
    @patch.object(COLLECTOR, "brew_executable", return_value="/opt/homebrew/bin/brew")
    @patch.object(COLLECTOR, "command_exists", return_value=False)
    @patch.object(COLLECTOR, "is_macos", return_value=True)
    def test_collects_homebrew_software(self, _is_macos, _exists, _brew, scan_command):
        scan_command.return_value = ("salt 3007.1\nclamav 1.4.2\ntrivy 0.66.0", "")

        with patch.object(COLLECTOR.os, "scandir", side_effect=FileNotFoundError):
            software = COLLECTOR.collect_installed_software(2)

        self.assertEqual([entry["name"] for entry in software], ["clamav", "salt"])
        self.assertTrue(all(entry["source"] == "homebrew" for entry in software))

    @patch.object(COLLECTOR, "run_command")
    def test_collects_macos_network_details(self, run_command):
        responses = {
            ("networksetup", "-listallhardwareports"): "Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff",
            ("ifconfig",): "en0: flags=8863<UP> mtu 1500\n\tether aa:bb:cc:dd:ee:ff\n\tinet 192.0.2.25 netmask 0xffffff00\nutun4: flags=8051<UP> mtu 1280\n\tinet 100.64.0.8 --> 100.64.0.8 netmask 0xffffffff",
            ("scutil", "--dns"): "  nameserver[0] : 192.0.2.1\n  nameserver[1] : 1.1.1.1",
            ("route", "-n", "get", "default"): "   gateway: 192.0.2.1\n interface: en0",
        }
        run_command.side_effect = lambda command, timeout=15: responses.get(tuple(command), "")

        network = COLLECTOR.collect_macos_network_details()

        self.assertEqual(network["wireless_ip"], "192.0.2.25")
        self.assertEqual(network["netbird_ip"], "100.64.0.8")
        self.assertEqual(network["gateway"], "192.0.2.1")
        self.assertEqual(network["dns"], "192.0.2.1, 1.1.1.1")
        self.assertEqual(network["interface_stats"]["en0"]["mac"], "aa:bb:cc:dd:ee:ff")


class TelemetryScanTest(unittest.TestCase):
    def setUp(self):
        # A missing mock must fail, not inspect this host or invoke an endpoint.
        self.guard = patch.object(COLLECTOR.subprocess, "run", side_effect=AssertionError("unmocked subprocess"))
        self.guard.start()
        self.addCleanup(self.guard.stop)
        directories = patch.object(COLLECTOR.os, "scandir", side_effect=FileNotFoundError)
        directories.start()
        self.addCleanup(directories.stop)

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "dpkg-query")
    @patch.object(COLLECTOR, "scan_command")
    def test_more_than_200_and_explicit_bound(self, scan, *_):
        scan.return_value = ("\n".join("installed\tpkg-%04d\t1.0" % i for i in range(301)), "")
        apps, status = COLLECTOR.collect_software_scan()
        self.assertEqual(len(apps), 301)
        self.assertEqual(status["status"], "success")
        apps, status = COLLECTOR.collect_software_scan(250)
        self.assertEqual(len(apps), 250)
        self.assertEqual(status["total"], 301)
        self.assertTrue(status["truncated"])
        self.assertEqual(status["status"], "partial")
        self.assertNotIn("apt-mark", str(scan.call_args_list))

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "rpm")
    @patch.object(COLLECTOR, "scan_command", return_value=("firefox\t130-1.x86_64\nlibfoo\t1-2.noarch", ""))
    def test_rpm_includes_dependencies(self, scan, *_):
        apps, status = COLLECTOR.collect_software_scan()
        self.assertEqual([app["name"] for app in apps], ["firefox", "libfoo"])
        self.assertEqual(status["status"], "success")
        self.assertEqual(scan.call_args.args[0][:2], ["rpm", "-qa"])

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "dpkg-query")
    @patch.object(COLLECTOR, "scan_command")
    def test_empty_software_is_not_failed(self, scan, *_):
        for output, error, expected in [("", "", "success"), ("", "timeout", "failed")]:
            scan.return_value = output, error
            apps, status = COLLECTOR.collect_software_scan()
            self.assertEqual(apps, [])
            self.assertEqual(status["status"], expected)

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", return_value=False)
    def test_missing_package_manager_is_not_zero(self, *_):
        count, details, reboot, status = COLLECTOR.collect_update_scan()
        self.assertIsNone(count)
        self.assertEqual(details, [])
        self.assertEqual(status["status"], "unsupported")

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "apt")
    @patch.object(COLLECTOR, "scan_command")
    def test_update_scan_once_and_successful_empty(self, scan, *_):
        for output, error, count, state in [("Listing... Done", "", 0, "success"),
                                          ("", "timeout", None, "failed"),
                                          ("Listing... Done\nfoo/stable 2.1 amd64 [upgradable from: 2.0]", "", 1, "success")]:
            scan.reset_mock()
            scan.return_value = output, error
            with patch.object(COLLECTOR.Path, "exists", return_value=False):
                result = COLLECTOR.collect_update_scan()
            self.assertEqual(result[0], count)
            self.assertEqual(result[3]["status"], state)
            scan.assert_called_once_with(["apt", "list", "--upgradable"], timeout=120, valid_codes=(0,))

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "dnf")
    @patch.object(COLLECTOR, "scan_command", return_value=("openssl.x86_64 3.2-1 updates\nopenssl.x86_64 3.2-1 updates", ""))
    def test_dnf_cached_read_only_updates(self, scan, *_):
        count, details, _, status = COLLECTOR.collect_update_scan()
        self.assertEqual(count, 1)
        self.assertEqual(status["status"], "success")
        self.assertEqual(len(details), 1)
        self.assertEqual(scan.call_args.kwargs["valid_codes"], (0, 100))
        self.assertIn("--cacheonly", scan.call_args.args[0])

    def test_subprocess_failure_timeout_and_dnf_100(self):
        with patch.object(COLLECTOR.subprocess, "run", return_value=types.SimpleNamespace(returncode=100, stdout="foo.x86_64 2 repo")):
            self.assertEqual(COLLECTOR.scan_command(["dnf"], valid_codes=(0, 100))[1], "")
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("apt", 1)):
            with patch.object(COLLECTOR.subprocess, "run", side_effect=error):
                output, reason = COLLECTOR.scan_command(["apt"])
                self.assertEqual(output, "")
                self.assertTrue(reason)

    @patch.object(COLLECTOR.shutil, "which", return_value="/Applications/AnyDesk.app/Contents/MacOS/AnyDesk")
    @patch.object(COLLECTOR, "run_command", return_value="password=must-not-leak")
    def test_remote_output_is_numeric_id_only(self, *_):
        self.assertEqual(COLLECTOR.collect_remote_access_id("anydesk"), "")

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "pip3")
    @patch.object(COLLECTOR, "scan_command")
    def test_malformed_or_empty_pip_response_never_success(self, scan, *_):
        for raw in ("", "{}", "null", '[{"version":"1"}]', '[null]'):
            with self.subTest(raw=raw):
                scan.return_value = raw, ""
                apps, status = COLLECTOR.collect_software_scan()
                self.assertEqual(apps, [])
                self.assertEqual(status["status"], "failed")
        scan.return_value = '[]', ""
        self.assertEqual(COLLECTOR.collect_software_scan()[1]["status"], "success")

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "snap")
    @patch.object(COLLECTOR, "scan_command", return_value=("unrecognized response", ""))
    def test_snap_bad_header_not_authoritative_empty(self, *_):
        self.assertEqual(COLLECTOR.collect_software_scan()[1]["status"], "failed")

    @patch.object(COLLECTOR, "is_macos", return_value=False)
    @patch.object(COLLECTOR, "command_exists", side_effect=lambda name: name == "dpkg-query")
    @patch.object(COLLECTOR, "scan_command")
    def test_software_identity_not_silently_shortened(self, scan, *_):
        name, version = "n" * 300, "v" * 200
        scan.return_value = "installed\t%s\t%s" % (name, version), ""
        apps, status = COLLECTOR.collect_software_scan()
        self.assertEqual((apps[0]["name"], apps[0]["version"]), (name, version))
        self.assertEqual(status["status"], "success")

    @patch.object(COLLECTOR, "is_macos", return_value=True)
    @patch.object(COLLECTOR, "brew_executable", return_value=None)
    @patch.object(COLLECTOR, "command_exists", return_value=False)
    @patch.object(COLLECTOR.os, "scandir", side_effect=PermissionError("sensitive path"))
    def test_macos_unreadable_app_roots_are_failed_not_empty(self, *_):
        apps, status = COLLECTOR.collect_software_scan()
        self.assertEqual(apps, [])
        self.assertEqual(status["status"], "failed")
        self.assertNotIn("sensitive", str(status))


class WindowsStaticCompatibilityTest(unittest.TestCase):
    def test_powershell_51_and_bounded_scans(self):
        root = MODULE_PATH.parent
        collector = (root / "push-system-inventory.ps1").read_text()
        installer = (root / "install-itms-agent.ps1").read_text()
        self.assertNotIn("??", collector + installer)
        self.assertEqual(collector.count('.Search("IsInstalled=0'), 1)
        for expected in ("-Timeout 120", "Registry::HKEY_USERS", "Get-AppxPackage -AllUsers", "collection_status", "reboot_required", "$SoftwareLimit = 5000"):
            self.assertIn(expected, collector)
        self.assertNotIn("' -UseDetailedHardwareInventory $'", installer)
        self.assertNotIn("Get-PendingUpdateCount", collector)


if __name__ == "__main__":
    unittest.main()