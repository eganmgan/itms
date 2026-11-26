import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Code2,
  Download,
  FileCode2,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import {
  Badge,
  Modal,
  PageHeader,
  Tabs,
  Terminal,
} from "../components/ui";
import { SSHTerminal } from "../components/SSHTerminal";
import { PatchLogsPanel, PatchReportsPanel, PatchResultsSummary } from "../components/PatchReporting";
import { executionLines, type PatchLog, type PatchReport } from "../lib/patchReports";
import { buildPatchRunSnapshot, patchSnapshotLimitError, type PatchBatchResult, type PatchRunSnapshot } from "../lib/patchRunSnapshot";
import { exportJson } from "../lib/exports";

interface PatchDevice { id: string; assetTag?: string; hostname: string; osName?: string; patchStatus?: string; department?: { name?: string } }
interface PatchAlert { id: string; assetTag?: string; hostname: string; department?: string; detail?: string; title: string; severity: string; resolved: boolean }
interface PatchAutomation { id: string; name: string; kind: "sls" | "sh"; content: string; description: string }

function statusLabel(status?: string) {
  return (status || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function patchRouteState(pathname = window.location.pathname) {
  const page = pathname.split("/").filter(Boolean)[1] || "console";
  if (page === "logs") return { workspaceSection: "Logs", module: "Salt", saltTab: "Execute Console" };
  if (page === "audit") return { workspaceSection: "Audit", module: "Salt", saltTab: "Execute Console" };
  if (page === "ssh") return { workspaceSection: "Overview", module: "SSH", saltTab: "Execute Console" };
  if (page === "automation") return { workspaceSection: "Overview", module: "Automation", saltTab: "Execute Console" };
  if (page === "reports") return { workspaceSection: "Overview", module: "Report", saltTab: "Execute Console" };
  if (page === "alerts") return { workspaceSection: "Overview", module: "Salt", saltTab: "Alerts" };
  if (page === "policies") return { workspaceSection: "Overview", module: "Salt", saltTab: "Policies" };
  return { workspaceSection: "Overview", module: "Salt", saltTab: "Execute Console" };
}

async function patchRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Patch API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function PatchPage({ pathname }: { pathname?: string } = {}) {
  const [browserPath, setBrowserPath] = useState(() => window.location.pathname);
  useEffect(() => {
    if (pathname !== undefined) return;
    const syncRoute = () => setBrowserPath(window.location.pathname);
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, [pathname]);
  const activePath = pathname ?? browserPath;
  if (["/patch/apps", "/patch/apps-services"].includes(activePath.replace(/\/$/, ""))) {
    return <section className="space-y-3"><h1 className="text-xl font-bold">Apps moved to Devices</h1><a href="/devices" className="text-brand-600 underline">Open Devices</a></section>;
  }
  return <PatchWorkspace pathname={activePath} />;
}

function PatchWorkspace({ pathname }: { pathname: string }) {
  // App owns route changes; standalone renders follow browser history. Derive
  // the section during render, not in an effect that briefly loads the old APIs.
  const { workspaceSection, module, saltTab } = patchRouteState(pathname);
  const [targetMode, setTargetMode] = useState("Department-Wise Execution");
  const [selectionType, setSelectionType] = useState("Single Department");
  const [singleDepartment, setSingleDepartment] = useState("IT Infrastructure");
  const [selectedDepartments, setSelectedDepartments] = useState([
    "IT Infrastructure",
    "Engineering",
  ]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState("");
  const [targetsError, setTargetsError] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [departmentsError, setDepartmentsError] = useState("");
  const workspaceRequest = useRef<AbortController | null>(null);
  const [panelVersion, setPanelVersion] = useState(0);
  const [confirmRun, setConfirmRun] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [sshTarget, setSshTarget] = useState("");
  const [sshAssetId, setSshAssetId] = useState("");
  const [sshSearch, setSshSearch] = useState("");
  const [automationType, setAutomationType] = useState<"sls" | "sh" | null>(null);
  const [systemId, setSystemId] = useState("");
  const [saltState, setSaltState] = useState("patch.baseline");
  const [executionType, setExecutionType] = useState("state.apply");
  const [shellCommand, setShellCommand] = useState("");
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [apiError, setApiError] = useState("");
  const [reportError, setReportError] = useState("");
  const [reportNotice, setReportNotice] = useState("");
  const [unsavedReport, setUnsavedReport] = useState<PatchRunSnapshot | null>(null);
  const [lastRun, setLastRun] = useState<PatchRunSnapshot | null>(null);
  const [savingReport, setSavingReport] = useState(false);
  const [live, setLive] = useState(false);
  const [dashboard, setDashboard] = useState({ total: 0, upToDate: 0, pending: 0, failed: 0, rebootPending: 0 });
  const [devices, setDevices] = useState<PatchDevice[]>([]);
  const [logs, setLogs] = useState<PatchLog[]>([]);
  const [audit, setAudit] = useState<PatchLog[]>([]);
  const [alerts, setAlerts] = useState<PatchAlert[]>([]);
  const [alertFilter, setAlertFilter] = useState("Open");
  const [alertSearch, setAlertSearch] = useState("");
  const [policies, setPolicies] = useState({ windowEnabled: true, windowStart: "22:00", windowEnd: "06:00", allowedRings: ["pilot", "standard"], departmentRings: [] as Array<{ match: string; ring: string }> });
  const [automations, setAutomations] = useState<PatchAutomation[]>([]);
  const [reports, setReports] = useState<PatchReport[]>([]);
  const [automationName, setAutomationName] = useState("");
  const [automationContent, setAutomationContent] = useState("");
  const departmentOptions = Array.from(new Set([...departments, ...devices.map(device => device.department?.name || '')].map(name => name.trim()).filter(Boolean))).sort();
  const availableDepartments = departmentOptions;
  const targets =
    selectionType === "Single Department"
      ? availableDepartments.filter(name => name === singleDepartment)
      : selectionType === "All Departments"
        ? availableDepartments
        : selectedDepartments.filter(name => availableDepartments.includes(name));
  const targetExpression =
    targetMode === "Single System ID Execution"
      ? systemId.trim()
      : targets.map((item) => `G@department:${JSON.stringify(item)}`).join(" or ");
  const operation = executionType === "test.ping" ? "test.ping" : executionType === "cmd.run" ? `cmd.run ${JSON.stringify(shellCommand)}` : `state.apply ${saltState}`;
  const packageCommand = executionType === "cmd.run" && /^(?:sudo\s+)?(?:apt|apt-get)(?:\s|$)/i.test(shellCommand.trim());
  const command =
    targetMode === "Single System ID Execution"
      ? `salt '${systemId.trim() || "<system-id>"}' ${operation}`
      : `salt -C ${JSON.stringify(targetExpression || "<department>")} ${operation}`;
  const output = [`$ ${command}`, "Ready. Review the command to begin execution."];
  const sshDevices = live ? devices.filter(device => [device.assetTag, device.hostname, device.osName, device.department?.name].filter(Boolean).join(' ').toLowerCase().includes(sshSearch.trim().toLowerCase())) : [];
  const visibleAlerts = alerts.filter(item => (alertFilter === "All" || (alertFilter === "Resolved" ? item.resolved : !item.resolved)) && [item.assetTag, item.hostname, item.department, item.title, item.detail, item.severity].filter(Boolean).join(" ").toLowerCase().includes(alertSearch.toLowerCase()));

  function openPatchPage(path: string) {
    const pathname = path === "console" ? "/patch" : `/patch/${path}`;
    if (window.location.pathname !== pathname) window.history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const loadPatchWorkspace = useCallback(async () => {
    workspaceRequest.current?.abort();
    const controller = new AbortController();
    workspaceRequest.current = controller;
    const token = localStorage.getItem("itms_token");
    setLive(false); setTargetsError(""); setDashboardError("");
    setDepartments([]); setDepartmentsError(""); setDepartmentsLoading(false);
    if (!token) { setDevices([]); setLoading(false); setDashboardLoading(false); return; }
    setLoading(true); setDashboardLoading(true);
    const options = { signal: controller.signal };
    setDepartmentsLoading(true);
    void patchRequest<Array<{ name: string }>>("/departments", token, options).then(data => {
      if (!Array.isArray(data)) throw new Error("Invalid department response");
      if (!controller.signal.aborted) setDepartments(data.map(item => item.name).filter(name => typeof name === 'string'));
    }).catch(error => {
      if (!controller.signal.aborted) setDepartmentsError(error instanceof Error ? error.message : "Department directory unavailable");
    }).finally(() => {
      if (!controller.signal.aborted) setDepartmentsLoading(false);
    });
    // Metrics are informational; only the authorized device request gates targets.
    void patchRequest<typeof dashboard>("/patch/dashboard", token, options).then(data => {
      if (!controller.signal.aborted) setDashboard(data);
    }).catch(error => {
      if (!controller.signal.aborted) setDashboardError(error instanceof Error ? error.message : "Patch metrics unavailable");
    }).finally(() => {
      if (!controller.signal.aborted) setDashboardLoading(false);
    });
    try {
      const deviceData = await patchRequest<PatchDevice[]>("/patch/devices", token, options);
      if (controller.signal.aborted) return;
      setDevices(deviceData); setLive(true); setPanelVersion(version => version + 1); setApiError("");
    } catch (error) {
      if (!controller.signal.aborted) {
        setTargetsError(error instanceof Error ? error.message : "Patch targets unavailable"); setDevices([]); setLive(false);
      }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);

  const dashboardValue = (key: keyof typeof dashboard) => dashboardLoading || dashboardError || !live ? "-" : String(dashboard[key]);

  useEffect(() => {
    void loadPatchWorkspace();
    const reload = () => {
      setLive(false); setConfirmRun(false); setSshOpen(false); setDevices([]); setLogs([]); setAudit([]); setAlerts([]); setReports([]); setAutomations([]); setOutputLines([]);
      setReportError(""); setReportNotice(""); setUnsavedReport(null);
      setLastRun(null);
      void loadPatchWorkspace();
    };
    window.addEventListener("itms-auth-changed", reload);
    return () => { workspaceRequest.current?.abort(); window.removeEventListener("itms-auth-changed", reload); };
  }, [loadPatchWorkspace]);

  useEffect(() => {
    const token = localStorage.getItem("itms_token");
    if (!token || !live) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const loadPanel = async () => {
      try {
        if (workspaceSection === "Logs") setLogs((await patchRequest<{ items: PatchLog[] }>("/patch/logs", token, options)).items);
        else if (workspaceSection === "Audit") setAudit((await patchRequest<{ items: PatchLog[] }>("/patch/audit", token, options)).items);
        else if (module === "Salt" && saltTab === "Alerts") setAlerts((await patchRequest<{ items: PatchAlert[] }>("/patch/alerts", token, options)).items);
        else if (module === "Salt" && saltTab === "Policies") setPolicies(await patchRequest<typeof policies>("/patch/policies", token, options));
        else if (module === "Automation") setAutomations((await patchRequest<{ items: PatchAutomation[] }>("/patch/automations", token, options)).items);
        else if (module === "Report") setReports(await patchRequest<PatchReport[]>("/patch/reports", token, options));
        setApiError("");
      } catch (error) { if (!controller.signal.aborted) setApiError(error instanceof Error ? error.message : "Patch panel unavailable"); }
    };
    void loadPanel();
    return () => controller.abort();
  }, [live, module, saltTab, workspaceSection, panelVersion]);

  useEffect(() => {
    if (departmentOptions.length && !departmentOptions.includes(singleDepartment)) setSingleDepartment(departmentOptions[0]);
  }, [departmentOptions, singleDepartment]);

  const toggleDepartment = (name: string) =>
    setSelectedDepartments((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  async function saveRunReport(snapshot: PatchRunSnapshot, token: string) {
    setSavingReport(true); setReportError(""); setReportNotice("Saving execution report...");
    try {
      const limitError = patchSnapshotLimitError(snapshot);
      if (limitError) throw new Error(limitError);
      if (!token) throw new Error("Connect your ITMS account before retrying the report save.");
      await patchRequest<PatchReport>("/patch/reports", token, { method: "POST", body: JSON.stringify(snapshot) });
      setUnsavedReport(null); setReportNotice("Execution report saved."); setPanelVersion(version => version + 1);
    } catch (error) {
      setUnsavedReport(snapshot); setReportNotice("");
      setReportError(`Report save failed: ${error instanceof Error ? error.message : "Report service unavailable"}. Execution output is unchanged. Check Reports before retrying the save if the response was lost, or download the snapshot for recovery. Do not rerun the remote operation to save its report.`);
    } finally { setSavingReport(false); }
  }

  const run = async () => {
    if (packageCommand) { setConfirmRun(false); setApiError("Package commands are not available in diagnostic mode. Select the update state and review it before execution."); return; }
    const token = localStorage.getItem("itms_token");
    setLastRun(null);
    setConfirmRun(false); setRunning(true); setApiError(""); setReportError(""); setReportNotice(""); setUnsavedReport(null); setOutputLines([`$ ${command}`, "Resolving Salt targets..."]);
    if (!token) { setApiError("Connect your ITMS account to run patch commands."); setRunning(false); return; }
    const request = { targetMode: targetMode === "Single System ID Execution" ? "system" : "departments", departments: targets, systemId: systemId.trim(), action: executionType === "test.ping" ? "test.ping" : executionType === "cmd.run" ? "custom-command" : "custom-state", state: executionType === "state.apply" ? saltState : "", command: executionType === "cmd.run" ? shellCommand.trim() : "" };
    const requestedAt = new Date().toISOString();
    let result: PatchBatchResult;
    try {
      result = await patchRequest<PatchBatchResult>("/patch/batch", token, { method: "POST", body: JSON.stringify(request) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Patch execution failed";
      setApiError(message); setOutputLines([`$ ${command}`, `ERROR: ${message}`]); setRunning(false); return;
    }
    const completedAt = new Date().toISOString();
    setOutputLines([`$ ${command}`, `Matched ${result.targetCount} managed endpoint(s)`, ...result.results.flatMap((item) => [`${item.assetId}: ${item.status.toUpperCase()}${item.error ? ` · ${item.error}` : ""}`, ...(item.assetTag || devices.find(device => device.id === item.assetId)?.assetTag ? [`Asset tag: ${item.assetTag || devices.find(device => device.id === item.assetId)?.assetTag}`] : []), ...executionLines(item.result)])]);
    try {
      const snapshot = buildPatchRunSnapshot(result, devices, { ...request, scopeLabel: request.targetMode === "system" ? `System: ${request.systemId}` : `Departments: ${request.departments.join(", ")}`, requestedAt, completedAt });
      if (localStorage.getItem("itms_token") === token) setLastRun(snapshot);
      await saveRunReport(snapshot, token);
    } catch (error) {
      setReportError(`Report not saved: ${error instanceof Error ? error.message : "Could not prepare snapshot"} Execution output is unchanged. Do not rerun the remote operation to save its report.`);
    } finally { await loadPatchWorkspace(); setRunning(false); }
  };

  function openSSH(target: string, assetID: string) {
    setSshTarget(target);
    setSshAssetId(assetID);
    setSshOpen(true);
  }

  useEffect(() => {
    if (module !== "SSH" || workspaceSection !== "Overview") setSshOpen(false);
  }, [module, workspaceSection]);

  async function loadReportDetail(id: string) {
    const token = localStorage.getItem("itms_token");
    if (!token) throw new Error("Connect your ITMS account to read patch reports.");
    // Historical evidence must not be silently backfilled from today's directory.
    return patchRequest<PatchReport>(`/patch/reports/${encodeURIComponent(id)}`, token);
  }

  async function saveAutomation() {
    if (!automationType) return;
    const token = localStorage.getItem("itms_token");
    if (!token) { setApiError("Connect your ITMS account to save patch automations."); return; }
    try { const created = await patchRequest<PatchAutomation>("/patch/automations", token, { method: "POST", body: JSON.stringify({ name: automationName, kind: automationType, content: automationContent }) }); setAutomations(current => [...current.filter(item => item.id !== created.id), created]); setAutomationType(null); setApiError(""); }
    catch (error) { setApiError(error instanceof Error ? error.message : "Automation could not be saved"); }
  }

  function openAutomation(kind: "sls" | "sh") {
    setAutomationType(kind);
    setAutomationName(kind === "sls" ? "patch.custom" : "fleet-maintenance.sh");
    setAutomationContent(kind === "sls" ? "security_updates:\n  pkg.uptodate:\n    - refresh: true" : "#!/usr/bin/env bash\nset -euo pipefail\nsalt-call state.apply patch.baseline");
  }

  async function savePolicies() {
    const token = localStorage.getItem("itms_token");
    if (!token) { setApiError("Connect your ITMS account to change patch policies."); return; }
    try {
      const updated = await patchRequest<typeof policies>("/patch/policies", token, { method: "PUT", body: JSON.stringify(policies) });
      setPolicies(updated); setApiError("");
    } catch (error) { setApiError(error instanceof Error ? error.message : "Patch policy could not be saved"); }
  }

  return (
    <div className="page-enter mx-auto max-w-[1500px] space-y-6 pb-20 [&_h1]:text-2xl">
      <PageHeader
        eyebrow="Remote operations"
        title="Salt patch engine"
        description="Execute policy-driven maintenance across departments and endpoints."
        actions={<><Badge tone={live ? "green" : "indigo"}>{live ? "Live API" : "API unavailable"}</Badge><button className="secondary-button" onClick={() => void loadPatchWorkspace()} disabled={loading}><RefreshCw size={16} className={loading ? "animate-spin" : ""} />{loading ? "Refreshing" : "Refresh"}</button></>}
      />
      <nav aria-label="Patch workspace" className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus(); tabs[next]?.click();
      }}>
        <Tabs
          tabs={["Salt", "SSH", "Automation", "Report", "Logs", "Audit"]}
          active={workspaceSection === "Overview" ? module : workspaceSection}
          onChange={(nextModule) => openPatchPage(nextModule === "Salt" ? "console" : nextModule === "Report" ? "reports" : nextModule.toLowerCase())}
        />
      </nav>
      <div className="min-w-0 space-y-5">
        {targetsError && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">Targets unavailable: {targetsError}</div>}
        {apiError && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{apiError}</div>}
        {reportNotice && <p role="status" className="text-sm font-bold">{reportNotice}</p>}
        {reportError && <div role="alert" className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800"><p>{reportError}</p>{unsavedReport && <div className="flex gap-2"><button className="secondary-button" disabled={savingReport || running || Boolean(patchSnapshotLimitError(unsavedReport))} onClick={() => void saveRunReport(unsavedReport, localStorage.getItem("itms_token") || "")}>Retry report save</button><button className="secondary-button" onClick={() => exportJson("patch-run-snapshot.json", unsavedReport)}>Download snapshot JSON</button></div>}</div>}
        {workspaceSection === "Overview" && <section aria-label="Patch metrics" className="space-y-3">
          {dashboardError && <p role="alert" className="text-sm text-amber-700">Metrics unavailable: {dashboardError}</p>}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {([
              ["Managed", "total", Server, "text-blue-600"],
              ["Up to date", "upToDate", Check, "text-emerald-600"],
              ["Pending", "pending", Download, "text-amber-600"],
              ["Failed", "failed", TerminalSquare, "text-rose-600"],
              ["Reboot", "rebootPending", RefreshCw, "text-slate-500"],
            ] as const).map(([label, key, Icon, color]) => <div key={key} className="min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <dt className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800"><Icon size={16} className={color} /></span>{label}</dt>
              <dd className="mt-3 text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{dashboardValue(key)}</dd>
            </div>)}
          </dl>
        </section>}
        {workspaceSection === "Logs" && <PatchLogsPanel logs={live ? logs : []} />}
        {workspaceSection === "Audit" && <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{["Time", "Actor", "Action", "Target"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{(live ? audit : []).map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.actor || "System"}</td><td className="font-bold">{item.action}</td><td>{item.assetTag || item.hostname || String(item.targetId || "Patch workspace")}</td></tr>)}{audit.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-slate-500">No patch audit events recorded yet.</td></tr>}</tbody></table></div>}
        {workspaceSection === "Overview" && module === "Salt" && (
          <div className="space-y-5">
            <div role="group" aria-label="Salt views" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {["Execute Console", "Alerts", "Policies"].map((item) => (
                <button
                  key={item}
                  aria-pressed={saltTab === item}
                  onClick={() => openPatchPage(item === "Execute Console" ? "console" : item.toLowerCase())}
                  className={`rounded-lg px-4 py-2.5 text-xs font-semibold transition-colors ${saltTab === item ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-700"}`}
                >
                  {item}
                </button>
              ))}
            </div>
            {saltTab === "Execute Console" ? (
              <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <section aria-label="Patch execution controls" className="min-w-0 space-y-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900">
                  <div className="min-w-0 space-y-4">
                  <h2 className="text-sm font-bold">Targets</h2>
                  <div>
                    <p id="patch-target-mode" className="mb-2 text-xs font-extrabold uppercase tracking-wider text-slate-400">
                      Target mode
                    </p>
                    <div role="group" aria-labelledby="patch-target-mode" className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-900">
                      {[
                        "Department-Wise Execution",
                        "Single System ID Execution",
                      ].map((item) => (
                        <button
                          key={item}
                          aria-label={item}
                          aria-pressed={targetMode === item}
                          onClick={() => setTargetMode(item)}
                          className={`min-h-10 rounded px-3 text-xs font-semibold ${targetMode === item ? "bg-brand-600 text-white shadow-sm" : "text-slate-500"}`}
                        >
                          {item === "Department-Wise Execution" ? "Departments" : "System ID"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {targetMode === "Department-Wise Execution" ? (
                    <>
                      {departmentsLoading && <p role="status" className="text-xs text-slate-500">Loading departments...</p>}
                      {departmentsError && <p role="alert" className="text-xs text-amber-700">Department directory unavailable: {departmentsError}. Only departments from loaded devices are shown.</p>}
                      {!departmentsLoading && !loading && !departmentsError && !targetsError && !availableDepartments.length && <p role="status" className="text-xs text-slate-500">No departments available for your account.</p>}
                      <div>
                        <p id="patch-selection-type" className="mb-2 text-xs font-extrabold uppercase tracking-wider text-slate-400">
                          Selection type
                        </p>
                        <div role="group" aria-labelledby="patch-selection-type" className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-900">
                          {["Single Department", "Multiple Departments", "All Departments"].map(
                            (item) => (
                              <button
                                key={item}
                                aria-label={item}
                                aria-pressed={selectionType === item}
                                onClick={() => setSelectionType(item)}
                                className={`flex-1 rounded px-2 py-2 text-xs font-bold ${selectionType === item ? "bg-brand-600 text-white shadow-sm" : "text-slate-500"}`}
                              >
                                {item === "Single Department" ? "Single" : item === "Multiple Departments" ? "Multiple" : "All"}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                      {selectionType === "Single Department" ? (
                        <select
                          aria-label="Department"
                          className="field"
                          value={singleDepartment}
                          onChange={(event) =>
                            setSingleDepartment(event.target.value)
                          }
                        >
                          {availableDepartments.map((item) => (
                            <option key={item}>{item}</option>
                          ))}
                        </select>
                      ) : selectionType === "Multiple Departments" ? (
                        <div role="group" aria-label="Departments" className="max-h-52 space-y-1 overflow-y-auto">
                          {availableDepartments.map((item) => {
                            const active = selectedDepartments.includes(item);
                            return (
                              <label
                                key={item}
                                className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-900"
                              >
                                <input type="checkbox" checked={active} onChange={() => toggleDepartment(item)} />
                                <span className="min-w-0 break-words">{item}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs font-semibold text-slate-500">All {availableDepartments.length} departments selected</p>
                      )}
                    </>
                  ) : (
                    <label className="block text-xs font-bold text-slate-500">
                      System ID
                      <input className="field mt-2" value={systemId} onChange={(event) => setSystemId(event.target.value)} />
                    </label>
                  )}
                  </div>
                </section>
                <div className="min-w-0 space-y-4">
                <section aria-label="Patch operation" className="min-w-0 space-y-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900">
                  <div className="min-w-0 space-y-4">
                  <h2 className="text-sm font-bold">Operation</h2>
                  <div role="group" aria-label="Execution type" className="grid grid-cols-3 gap-2">{([['state.apply', 'Salt state', FileCode2], ['cmd.run', 'Diagnostic command', TerminalSquare], ['test.ping', 'Salt connectivity', Server]] as const).map(([kind, label, Icon]) => <button key={kind} aria-label={`${kind} · ${label}`} aria-pressed={executionType === kind} className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-[11px] ${executionType === kind ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900'}`} onClick={() => setExecutionType(kind)}><Icon size={14} /><span className="font-semibold">{kind === 'state.apply' ? 'State' : kind === 'cmd.run' ? 'Command' : 'Ping'}</span><code className="text-[9px]">{kind}</code></button>)}</div>
                  {executionType === "test.ping" ? null : executionType === "cmd.run" ? <label className="block text-xs font-bold text-slate-500">Command<textarea rows={4} className="field mt-2 resize-y font-mono" value={shellCommand} onChange={event => setShellCommand(event.target.value)} placeholder="uptime" /></label> : <label className="block text-xs font-bold text-slate-500">
                    Salt State
                    <select className="field mt-2" value={saltState} onChange={(event) => setSaltState(event.target.value)}>
                      <option>patch.baseline</option>
                      <option>security.hardening</option>
                      <option>agent.restart</option>
                    </select>
                  </label>}
                  {packageCommand && <div className="space-y-3 border-l-2 border-amber-500 pl-3">
                    <p role="alert" className="text-xs text-amber-800 dark:text-amber-200">Package commands are blocked in diagnostic mode. apt update refreshes package lists only. Installing pending upgrades requires the patch.baseline state.</p>
                    <button className="secondary-button h-auto min-h-9 whitespace-normal py-2" disabled={running} onClick={() => { setExecutionType("state.apply"); setSaltState("patch.baseline"); setConfirmRun(false); }}><FileCode2 size={16} className="shrink-0" />Use update state</button>
                  </div>}
                  </div>
                  <div className="border-t pt-4 text-xs"><span className="font-bold text-slate-500">Selected scope</span><p className="mt-2 break-words font-mono text-slate-700 dark:text-slate-200">{targetExpression || "No targets selected"}</p></div>
                  <button className="primary-button w-full sm:w-auto" onClick={() => setConfirmRun(true)} disabled={!live || running || packageCommand || (executionType === "cmd.run" && !shellCommand.trim()) || (targetMode === "Department-Wise Execution" ? targets.length === 0 : !systemId.trim())}>
                    <Play size={16} />
                    {running ? "Running..." : `Review ${executionType}`}
                  </button>
                </section>
                <section aria-labelledby="patch-execution-stream" className="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900">
                  {lastRun && <PatchResultsSummary rows={lastRun.rows} />}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="patch-execution-stream" className="text-sm font-bold">
                      Terminal execution stream
                    </h2>
                    <Badge tone={running ? 'amber' : 'slate'}>{running ? 'Running' : outputLines.length ? 'Last execution' : 'Awaiting execution'}</Badge>
                  </div>
                  <div className="[&>div]:rounded-lg [&>div]:shadow-none [&>div>div:last-child]:min-h-72 [&>div>div:last-child]:max-h-[32rem] [&>div>div:last-child]:whitespace-pre-wrap [&>div>div:last-child]:break-words"><Terminal lines={outputLines.length ? outputLines : output} /></div>
                </section>
                </div>
              </div>
            ) : saltTab === "Alerts" ? (
              <section className="space-y-4">
                <div className="flex flex-wrap gap-2">{["Open", "Resolved", "All"].map(filter => <button key={filter} className={alertFilter === filter ? "primary-button" : "secondary-button"} onClick={() => setAlertFilter(filter)}>{filter}</button>)}<input className="field max-w-sm" aria-label="Search patch alerts" value={alertSearch} onChange={event => setAlertSearch(event.target.value)} placeholder="Search asset, department or update" /></div>
                <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{["System", "Department", "Alert", "Severity", "Status"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{(live ? visibleAlerts : []).map((item) => <tr key={item.id}><td><strong className="font-mono text-brand-600">{item.assetTag || "Asset tag not recorded"}</strong><p>{item.hostname}</p></td><td>{item.department || "Unassigned"}</td><td>{item.title}<p className="text-xs text-slate-500">{item.detail}</p>{item.severity === "critical" && !item.resolved && <Badge tone="rose">Critical update</Badge>}</td><td><Badge tone={item.severity === "critical" || item.severity === "high" ? "rose" : "amber"}>{statusLabel(item.severity)}</Badge></td><td><Badge tone={item.resolved ? "green" : "amber"}>{item.resolved ? "Resolved" : "Open"}</Badge></td></tr>)}{!visibleAlerts.length && <tr><td colSpan={5} className="py-10 text-center text-slate-500">No matching patch alerts.</td></tr>}</tbody></table></div>
              </section>
            ) : (
              <div className="grid gap-6 lg:grid-cols-3">
                <section className="min-w-0 space-y-4"><h2 className="text-sm font-bold">Maintenance window</h2><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policies.windowEnabled} onChange={event => setPolicies(current => ({ ...current, windowEnabled: event.target.checked }))} />Window enabled</label><div className="grid grid-cols-2 gap-3"><label className="block text-xs font-semibold text-slate-500">Window starts<input className="field mt-2" type="time" value={policies.windowStart} onChange={event => setPolicies(current => ({ ...current, windowStart: event.target.value }))} /></label><label className="block text-xs font-semibold text-slate-500">Window ends<input className="field mt-2" type="time" value={policies.windowEnd} onChange={event => setPolicies(current => ({ ...current, windowEnd: event.target.value }))} /></label></div></section>
                <section className="space-y-4 lg:border-l lg:pl-6"><h2 className="text-sm font-bold">Allowed rings</h2>{Array.from(new Set(["pilot", "standard", "broad", ...policies.allowedRings])).map(ring => <label key={ring} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policies.allowedRings.includes(ring)} onChange={event => setPolicies(current => ({ ...current, allowedRings: event.target.checked ? [...current.allowedRings, ring] : current.allowedRings.filter(item => item !== ring) }))} />{statusLabel(ring)}</label>)}{!policies.allowedRings.length && <Badge tone="amber">All rings allowed</Badge>}</section>
                <section className="min-w-0 space-y-4 lg:border-l lg:pl-6"><h2 className="text-sm font-bold">Department rules</h2><p className="text-xs text-slate-500">{policies.departmentRings.length} custom assignments</p><dl className="divide-y">{policies.departmentRings.map((rule, index) => <div key={index} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><dt className="break-words">{rule.match}</dt><dd className="font-semibold">{rule.ring}</dd></div>)}</dl></section>
                <div className="border-t pt-4 lg:col-span-3"><button className="primary-button" onClick={() => void savePolicies()}><Check size={16} />Save Policy</button></div>
              </div>
            )}
          </div>
        )}
        {workspaceSection === "Overview" && module === "SSH" && (
          <div className="space-y-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><h2 className="text-sm font-bold">Managed endpoints <span className="ml-2 font-normal text-slate-500">{loading ? '-' : sshDevices.length}</span></h2><label className="relative block w-full sm:max-w-sm"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" /><input className="field !pl-9" aria-label="Search SSH endpoints" placeholder="Search hostname, asset or department" value={sshSearch} onChange={event => setSshSearch(event.target.value)} /></label></div>
            <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['System', 'Operating system', 'Department', 'Patch status', 'Action'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
              {sshDevices.map(device => <tr key={device.id}><td><strong className="break-words">{device.hostname || 'Hostname not recorded'}</strong><p className="text-xs text-slate-500">{device.assetTag || 'Asset tag not recorded'}</p></td><td>{device.osName || 'Not recorded'}</td><td>{device.department?.name || 'Unassigned'}</td><td><Badge tone={device.patchStatus === 'up_to_date' ? 'green' : device.patchStatus === 'failed' ? 'rose' : 'amber'}>{statusLabel(device.patchStatus)}</Badge></td><td><button className="secondary-button whitespace-nowrap" onClick={() => openSSH(device.assetTag || device.hostname, device.id)}><TerminalSquare size={16} />SSH Terminal</button></td></tr>)}
              {!sshDevices.length && <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-500">{loading ? 'Loading endpoints...' : sshSearch.trim() ? 'No matching endpoints.' : 'No managed endpoints available.'}</td></tr>}
            </tbody></table></div>
          </div>
        )}
        {workspaceSection === "Overview" && module === "Automation" && (
          <div className="space-y-4"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><h2 className="text-sm font-bold">Saved automations</h2><div className="flex flex-wrap gap-2"><button className="primary-button" onClick={() => openAutomation("sls")}><Code2 size={16} />New .sls State</button><button className="secondary-button" onClick={() => openAutomation("sh")}><TerminalSquare size={16} />New .sh Script</button></div></div>{automations.length > 0 ? <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead><tbody>{automations.map((item) => <tr key={item.id}><td className="font-bold">{item.name}</td><td>{item.kind}</td><td>{item.description || "Reusable patch automation"}</td></tr>)}</tbody></table></div> : live && <div className="border-y py-10 text-center text-sm text-slate-500">No saved automations yet.</div>}</div>
        )}
        {workspaceSection === "Overview" && module === "Report" && live && (
          <PatchReportsPanel reports={reports} loadDetail={loadReportDetail} />
        )}
        {sshOpen && (
          <Modal
            title={`SSH · ${sshTarget}`}
            onClose={() => setSshOpen(false)}
            size="min-w-0 max-w-6xl [&_h2]:break-all"
          >
            <div className="min-w-0 max-w-full overflow-x-hidden p-2 sm:p-5">
              <SSHTerminal assetId={sshAssetId} systemId={sshTarget} />
            </div>
          </Modal>
        )}
        {confirmRun && <Modal title="Confirm patch execution" onClose={() => setConfirmRun(false)}><div className="space-y-4 p-5"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40"><ShieldCheck size={18} /></span><div><p className="text-sm font-bold">Run {executionType === "cmd.run" ? shellCommand : saltState} on the selected scope?</p><p className="mt-1 text-xs text-slate-500">This executes a remote {executionType === "cmd.run" ? "shell command" : "Salt state"} and records the result in audit history. Review the target and command before proceeding.</p></div></div><div className="rounded-md border bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-200">{command}</div><div className="flex justify-end gap-2"><button className="secondary-button" onClick={() => setConfirmRun(false)}>Cancel</button><button className="primary-button" onClick={() => void run()}><Play size={16} />Confirm & Run</button></div></div></Modal>}
        {automationType && <Modal title={automationType === "sls" ? "New Salt state" : "New shell script"} onClose={() => setAutomationType(null)} size="max-w-3xl"><div className="space-y-4 p-5"><label className="block text-xs font-bold text-slate-500">Name<input className="field mt-2" value={automationName} onChange={(event) => setAutomationName(event.target.value)} /></label><label className="block text-xs font-bold text-slate-500">Content<textarea className="field mt-2 min-h-52 font-mono" value={automationContent} onChange={(event) => setAutomationContent(event.target.value)} /></label><div className="flex justify-end gap-2"><button className="secondary-button" onClick={() => setAutomationType(null)}>Cancel</button><button className="primary-button" onClick={() => void saveAutomation()} disabled={!automationName.trim() || !automationContent.trim()}>Save Automation</button></div></div></Modal>}
      </div>
    </div>
  );
}
