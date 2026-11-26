import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BellRing,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Megaphone,
  Copy,
  Search,
  TicketCheck,
  UserPlus,
  Plus,
  Send,
  RefreshCw,
  X,
} from "lucide-react";
import {
  Badge,
  MetricCard,
  Modal,
  ModuleWorkspace,
  PageHeader,
  Tabs,
} from "../components/ui";
import { EmployeeDirectory } from "../components/EmployeeDirectory";
import { exportCsv, exportElementPdf } from "../lib/exports";
import { usePortalReadOnly } from "../lib/portalAccess";
import { subscribeAuth } from "../lib/auth";
import { warrantyNotice } from "../lib/warranty";
import { indiaDay, useIndiaDay } from "../lib/indiaDay";
import { EmployeeDashboard } from "./EmployeeDashboard";
import { EmployeeWorkload } from "./EmployeeWorkload";

interface RequestAsset { id: string; name: string; assetTag?: string | null; itemCode?: string; warrantyExpiresAt?: string | null }

function useEmployeeAssets(enabled: boolean) {
  const [state, setState] = useState<{ token: string; assets: RequestAsset[]; error: string }>({ token: "", assets: [], error: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeAuth(() => setRevision(value => value + 1)), []);
  useEffect(() => {
    if (!enabled) return;
    const token = localStorage.getItem("itms_token");
    if (!token) return;
    let active = true;
    let pending = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      try {
        const data = await employeeRequest<{ devices: RequestAsset[]; items: RequestAsset[] }>("/me/assets", token, { signal: controller.signal, cache: "no-store" });
        if (!Array.isArray(data.devices) || !Array.isArray(data.items)) throw new Error("Invalid assets");
        if (active && !controller.signal.aborted && token === localStorage.getItem("itms_token")) setState({ token, assets: [...data.devices, ...data.items], error: "" });
      } catch {
        if (active && token === localStorage.getItem("itms_token")) setState({ token, assets: [], error: "Assigned assets and warranty notifications unavailable." });
      } finally { window.clearTimeout(timeout); pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [enabled, revision]);
  return state.token === localStorage.getItem("itms_token") ? { ...state, loading: false } : { assets: [], error: "", loading: true };
}

interface EmployeeRequest {
  id: string;
  ticketNumber?: string;
  type: string;
  title: string;
  description: string;
  status: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  requester: { id: string; fullName: string };
  assignee: { id: string | null; fullName: string };
  comments: Array<{ id: string; author: string; note: string; createdAt: string }>;
}

interface EmployeeAnnouncement {
  id: string;
  title: string;
  body: string;
  audience: string;
  urgent: boolean;
  createdAt: string;
  authorName: string;
}

interface EmployeeRequestView {
  id: string;
  ticketNumber?: string;
  employee: string;
  owner: string;
  ownerId?: string | null;
  category: string;
  issue: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  comments: EmployeeRequest["comments"];
  notes: string;
}

interface EmployeeDepartment {
  id: string;
  entity_id: string;
  entity_code: string;
  name: string;
}

interface CreatedEmployee {
  username: string;
  email: string;
  employeeId: string;
  department: string;
  temporaryPassword: string;
}

function generateTemporaryPassword() {
  const random = new Uint8Array(12);
  crypto.getRandomValues(random);
  return `Itms!${Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("")}Aa1`;
}

function DepartmentMenu({ value, departments, loading, onChange }: { value: string; departments: EmployeeDepartment[]; loading: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = departments.find((department) => department.id === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const gap = 4;
    const preferredHeight = 208;
    const spaceAbove = bounds.top - gap;
    const spaceBelow = window.innerHeight - bounds.bottom - gap;
    const openBelow = spaceBelow >= Math.min(preferredHeight, spaceAbove);
    setPosition({
      left: bounds.left,
      ...(openBelow ? { top: bounds.bottom + gap } : { bottom: window.innerHeight - bounds.top + gap }),
      width: bounds.width,
      maxHeight: Math.max(96, Math.min(preferredHeight, openBelow ? spaceBelow - 8 : spaceAbove - 8)),
    });
    setOpen(true);
  }

  return <div className="relative">
    <span className="text-xs font-bold text-slate-500">Department</span>
    <button ref={triggerRef} type="button" role="combobox" aria-label="Department" aria-expanded={open} aria-controls="manual-user-department-options" disabled={loading || departments.length === 0} className="field mt-2 flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60" onPointerDown={(event) => event.stopPropagation()} onClick={toggleMenu}>
      <span className="truncate">{loading ? "Loading departments..." : selected ? `${selected.name}${selected.entity_code ? ` · ${selected.entity_code}` : ""}` : "Select department"}</span>
      <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && position && createPortal(<div ref={menuRef} id="manual-user-department-options" role="listbox" aria-label="Department options" className="fixed z-[200] overflow-y-auto rounded-md border bg-white p-1 shadow-xl dark:bg-slate-900" style={position} onPointerDown={(event) => event.stopPropagation()}>
      {departments.map((department) => <button key={department.id} type="button" role="option" aria-selected={department.id === value} className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-xs ${department.id === value ? "bg-blue-50 font-bold text-brand-600 dark:bg-blue-950/40" : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onChange(department.id); setOpen(false); }} onClick={() => { onChange(department.id); setOpen(false); }}>
        <span>{department.name}{department.entity_code ? ` · ${department.entity_code}` : ""}</span>
        {department.id === value && <Check size={14} />}
      </button>)}
    </div>, document.body)}
  </div>;
}

async function employeeRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Employee API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function EmployeeRequestForm({ onClose, onCreated }: { onClose: () => void; onCreated: (ticket: string) => void }) {
  const [token] = useState(() => localStorage.getItem("itms_token"));
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  const [assets, setAssets] = useState<RequestAsset[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState("");
  const [itemsRevision, setItemsRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeAuth(() => { if (token !== localStorage.getItem("itms_token")) controller.current?.abort(); });
    return () => { controller.current?.abort(); unsubscribe(); };
  }, [token]);
  useEffect(() => {
    const active = new AbortController();
    let mounted = true;
    const unsubscribe = subscribeAuth(() => { if (token !== localStorage.getItem("itms_token")) active.abort(); });
    const timeout = window.setTimeout(() => active.abort(), 8000);
    setItems([]); setAssets([]); setItemsLoading(true); setItemsError("");
    void (async () => {
      try {
        if (!token || token !== localStorage.getItem("itms_token")) throw new Error("Account changed");
        const [data, assigned] = await Promise.all([
          employeeRequest<Array<{ id: string; name: string }>>("/me/requests/items", token, { signal: active.signal, cache: "no-store" }),
          employeeRequest<{ devices: RequestAsset[]; items: RequestAsset[] }>("/me/assets", token, { signal: active.signal, cache: "no-store" }),
        ]);
        if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string")) throw new Error("Invalid catalog");
        if (!Array.isArray(assigned.devices) || !Array.isArray(assigned.items)) throw new Error("Invalid assigned assets");
        if (mounted && !active.signal.aborted && token === localStorage.getItem("itms_token")) { setItems(data); setAssets([...assigned.devices, ...assigned.items]); }
      } catch {
        if (mounted && token === localStorage.getItem("itms_token")) setItemsError("Asset list unavailable. Try again.");
      } finally { window.clearTimeout(timeout); if (mounted) setItemsLoading(false); }
    })();
    return () => { mounted = false; active.abort(); window.clearTimeout(timeout); unsubscribe(); };
  }, [token, itemsRevision]);
  async function submit(form: HTMLFormElement) {
    if (!token || token !== localStorage.getItem("itms_token") || pending.current || uncertain || itemsLoading || itemsError) return;
    const data = new FormData(form);
    const description = String(data.get("description") || "").trim();
    const asset = assets.find(item => item.id === data.get("asset"));
    const catalogItem = items.find(item => `catalog:${item.id}` === data.get("asset"));
    const selected = asset || catalogItem;
    if (!selected) { setError("Select an asset from the list."); return; }
    const requestType = form.elements.namedItem("type") as HTMLSelectElement;
    const title = `${requestType.selectedOptions[0].text} - ${selected.name}`.slice(0, 200);
    const details = `Asset: ${selected.name} (${asset ? asset.assetTag || asset.itemCode || asset.id : "catalog item"})\n\n${description}`;
    if (!data.get("type")) { setError("Select a request type."); return; }
    if (!description) { setError("Enter a reason for the request."); return; }
    pending.current = true; setBusy(true); setError("");
    const active = new AbortController();
    controller.current = active;
    const timeout = window.setTimeout(() => active.abort(), 10000);
    try {
      const result = await employeeRequest<{ id: string; ticketNumber?: string }>("/me/requests", token, { method: "POST", signal: active.signal, body: JSON.stringify({ type: data.get("type"), title, description: details, priority: data.get("priority") }) });
      if (active.signal.aborted || token !== localStorage.getItem("itms_token")) return;
      if (!result.id) throw new Error("Request not confirmed");
      onCreated(result.ticketNumber || result.id);
    } catch {
      if (token === localStorage.getItem("itms_token")) { setUncertain(true); setError("Submission not confirmed. Close this form and refresh request history before trying again."); }
    } finally { window.clearTimeout(timeout); pending.current = false; setBusy(false); }
  }
  return <Modal title="Raise Request" onClose={() => { if (!busy) onClose(); }}><form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
    <label className="block text-sm">Request type<select name="type" className="field mt-2" defaultValue="" disabled={busy || itemsLoading || !!itemsError} required><option value="" disabled>Select request type</option>{items.map(item => <option key={item.id} value={`${item.name.toLowerCase().replace(/\s+/g, "_")}_replacement`}>{item.name} replacement</option>)}<option value="software_installation">Install new software</option><option value="manager_approval">Manager approval request</option><option value="other">Other IT support</option></select></label>
    <label className="block text-sm">Asset<select name="asset" className="field mt-2" defaultValue="" required disabled={busy || itemsLoading || !!itemsError || (!assets.length && !items.length)}><option value="" disabled>{itemsLoading ? "Loading assets..." : "Select asset"}</option>{assets.length > 0 && <optgroup label="Assigned equipment">{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name} - {asset.assetTag || asset.itemCode || asset.id}</option>)}</optgroup>}{items.length > 0 && <optgroup label="Catalog items">{items.map(item => <option key={item.id} value={`catalog:${item.id}`}>{item.name}</option>)}</optgroup>}</select></label>
    {itemsError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-rose-700">{itemsError}</p><button type="button" className="secondary-button" onClick={() => setItemsRevision(value => value + 1)}><RefreshCw size={16} />Retry asset list</button></div>}
    {!itemsLoading && !itemsError && !assets.length && !items.length && <p role="status" className="text-sm">No assigned equipment or catalog items available.</p>}
    <label className="block text-sm">Reason<textarea name="description" className="field mt-2" rows={4} required maxLength={4000} disabled={busy} /></label>
    <label className="block text-sm">Priority<select name="priority" className="field mt-2" defaultValue="medium" disabled={busy}><option value="low">Low</option><option value="medium">Normal</option><option value="high">High</option><option value="critical">Critical</option></select></label>
    <p className="text-xs text-slate-500">To: IT / Admin team</p>
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    <div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || uncertain || itemsLoading || !!itemsError || (!assets.length && !items.length)}><Send size={16} />{busy ? "Sending..." : "Send request"}</button></div>
  </form></Modal>;
}

export function EmployeePage({ role, dashboard = false, canManageWorkload = false }: { role?: string; dashboard?: boolean; canManageWorkload?: boolean }) {
  const portalReadOnly = usePortalReadOnly();
  const readOnly = portalReadOnly || role === "employee";
  const [tab, setTab] = useState("Employee Requests");
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestHistory, setRequestHistory] = useState(false);
  const assignedAssets = useEmployeeAssets(role === "employee");
  const [filter, setFilter] = useState("All");
  const [selectedRequest, setSelectedRequest] = useState<EmployeeRequestView | null>(null);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [createdEmployee, setCreatedEmployee] = useState<CreatedEmployee | null>(null);
  const [departmentId, setDepartmentId] = useState("");
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [severity, setSeverity] = useState("ALL");
  const [search, setSearch] = useState("");
  const [requestSearch, setRequestSearch] = useState("");
  const today = useIndiaDay();
  const [notice, setNotice] = useState("");
  const [liveRequests, setLiveRequests] = useState<EmployeeRequest[]>([]);
  const [liveAnnouncements, setLiveAnnouncements] = useState<EmployeeAnnouncement[]>([]);
  const [departments, setDepartments] = useState<EmployeeDepartment[]>([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const loadEmployeeWorkspace = useCallback(async (background = false) => {
    if (background && loadController.current) return;
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const token = localStorage.getItem("itms_token");
    if (!background) {
      setRequestOpen(false);
      setLive(false); setLiveRequests([]); setLiveAnnouncements([]); setDepartments([]); setSelectedRequest(null); setAnnouncementOpen(false); setEmployeeOpen(false); setCreatedEmployee(null);
    }
    setApiError("");
    if (!token) { setLoading(false); setApiError("Sign in to load employee data."); return; }
    const controller = new AbortController();
    loadController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const current = () => generation === loadGeneration.current && token === localStorage.getItem("itms_token");
    if (!background) setLoading(true);
    try {
      const [activeData, rejectedData, announcementData, departmentData] = await Promise.all([
        employeeRequest<EmployeeRequest[]>(role === "employee" ? "/me/requests" : "/requests", token, { signal: controller.signal }),
        role === "employee" ? Promise.resolve([] as EmployeeRequest[]) : employeeRequest<EmployeeRequest[]>("/requests?status=rejected", token, { signal: controller.signal }),
        employeeRequest<EmployeeAnnouncement[]>("/announcements", token, { signal: controller.signal }),
        role === "employee" ? Promise.resolve([] as EmployeeDepartment[]) : employeeRequest<EmployeeDepartment[]>("/departments", token, { signal: controller.signal }),
      ]);
      if (!current() || controller.signal.aborted) return;
      setLiveRequests([...activeData, ...rejectedData.filter((item) => !activeData.some((active) => active.id === item.id))]);
      setLiveAnnouncements(announcementData);
      setDepartments(departmentData);
      setLive(true);
      setApiError("");
    } catch (error) {
      if (current()) {
        setApiError(controller.signal.aborted ? "Employee request timed out. Refresh to try again." : error instanceof Error ? error.message : "Employee workspace unavailable");
        setLive(false);
      }
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      if (loadController.current === controller) loadController.current = null;
      if (current() && !background) setLoading(false);
    }
  }, [role]);

  const cancelLoading = useCallback(() => { ++loadGeneration.current; loadController.current?.abort(); }, []);
  useEffect(() => { void loadEmployeeWorkspace(); return cancelLoading; }, [loadEmployeeWorkspace, cancelLoading]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadEmployeeWorkspace(true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadEmployeeWorkspace]);
  useEffect(() => subscribeAuth(() => { setNotice(""); void loadEmployeeWorkspace(); }), [loadEmployeeWorkspace]);
  const requestItems: EmployeeRequestView[] = live ? liveRequests.map((item) => ({
    id: item.id,
    ticketNumber: item.ticketNumber,
    employee: item.requester.fullName,
    owner: item.assignee.fullName || "Unassigned",
    ownerId: item.assignee.id,
    category: item.type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    issue: item.description || item.title,
    status: item.status === "resolved" ? "Approved" : item.status === "rejected" ? "Rejected" : item.status === "in_progress" ? "In Progress" : "Pending",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    comments: item.comments,
    notes: item.notes,
  })) : [];
  const requestQuery = requestSearch.trim().toLowerCase();
  const currentRequests = requestItems.filter((item) => requestQuery
    ? [item.ticketNumber, item.id, item.employee, item.owner, item.category, item.issue, item.status].join(" ").toLowerCase().includes(requestQuery)
    : indiaDay(Date.parse(item.createdAt)) === today);
  const visibleRequests = currentRequests.filter((item) => filter === "All" || item.status === filter);
  const counts = Object.fromEntries(["Pending", "Approved", "Rejected"].map((status) => [status, currentRequests.filter((item) => item.status === status).length]));
  const reportLogs = live ? requestItems.flatMap((item) => {
    const base = [[new Date(item.updatedAt).toLocaleString(), item.ticketNumber || item.id, item.employee, item.status === "Approved" ? "Request resolved" : item.status === "Rejected" ? "Request rejected" : "Request updated", item.status === "Approved" ? "SUCCESS" : item.status === "Pending" ? "PENDING" : "INFO", item.status]];
    return [...base, ...item.comments.map((comment) => [new Date(comment.createdAt).toLocaleString(), item.ticketNumber || item.id, comment.author, comment.note, "INFO", item.status])];
  }) : [];
  const visibleLogs = reportLogs.filter(
    (row) =>
      (severity === "ALL" || row[4] === severity) &&
      row.join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  const reportTicketCount = new Set(visibleLogs.map((row) => row[1])).size;
  const reportEmployeeCount = new Set(visibleLogs.map((row) => row[2])).size;
  const reportPendingCount = visibleLogs.filter((row) => row[4] === "PENDING").length;

  async function downloadActivityReport() {
    const report = logsRef.current;
    if (!report || pdfBusy) return;
    setPdfBusy(true);
    setPdfError("");
    try {
      await exportElementPdf(report, "employee-support-logs.pdf", { orientation: "landscape" });
    } catch (error) {
      setPdfError(error instanceof Error ? `PDF report could not be generated: ${error.message}` : "PDF report could not be generated.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function updateStatus(item: EmployeeRequestView, status: "resolved" | "rejected") {
    if (readOnly) return;
    if (!live || loading) return;
    const token = localStorage.getItem("itms_token");
    if (!token) {
      setApiError("Connect your ITMS account to update employee requests.");
      return;
    }
    try {
      await employeeRequest(`/requests/${item.id}/status`, token, { method: "PUT", body: JSON.stringify({ status, notes: status === "resolved" ? "Approved from Employee support hub" : "Rejected from Employee support hub" }) });
      setNotice(`${item.ticketNumber || item.id} ${status === "resolved" ? "approved" : "rejected"}.`);
      setSelectedRequest(null);
      await loadEmployeeWorkspace();
    } catch (error) { setApiError(error instanceof Error ? error.message : "Request status could not be updated"); }
  }

  async function publishAnnouncement(form: HTMLFormElement) {
    if (readOnly) return;
    if (!live || loading) return;
    const data = new FormData(form);
    const priority = String(data.get("priority"));
    const token = localStorage.getItem("itms_token");
    const payload = { title: String(data.get("title")), body: String(data.get("message")), audience: String(data.get("audience")), urgent: priority === "Urgent Notice" };
    if (!token) {
      setApiError("Connect your ITMS account to publish announcements.");
      return;
    }
    try {
      await employeeRequest("/announcements", token, { method: "POST", body: JSON.stringify(payload) });
      setAnnouncementOpen(false);
      setNotice("Announcement published to the selected audience.");
      await loadEmployeeWorkspace();
    } catch (error) { setApiError(error instanceof Error ? error.message : "Announcement could not be published"); }
  }

  function closeEmployeeModal() {
    setEmployeeOpen(false);
    setCreatedEmployee(null);
    setDepartmentId("");
    setEmployeeError("");
  }

  async function createEmployee(form: HTMLFormElement) {
    if (readOnly) return;
    if (!live || loading || employeeLoading) return;
    const data = new FormData(form);
    const department = departments.find((item) => item.id === departmentId);
    const username = String(data.get("username")).trim();
    const email = String(data.get("email")).trim().toLowerCase();
    const employeeId = String(data.get("employeeId")).trim();
    const temporaryPassword = generateTemporaryPassword();
    const token = localStorage.getItem("itms_token");
    if (!token) {
      setEmployeeError("Sign in as an admin to add a user.");
      return;
    }
    if (!department) { setEmployeeError("Select a valid department."); return; }
    setEmployeeLoading(true);
    setEmployeeError("");
    try {
      await employeeRequest("/users", token, { method: "POST", body: JSON.stringify({ full_name: username, email, emp_id: employeeId, entity_id: department.entity_id, dept_id: department.id, location_id: "", role: "employee", initial_password: temporaryPassword, is_active: true }) });
      setCreatedEmployee({ username, email, employeeId, department: department.name, temporaryPassword });
      setNotice(`${username} added as an employee.`);
    } catch (error) { setEmployeeError(error instanceof Error ? error.message : "User could not be added"); }
    finally { setEmployeeLoading(false); }
  }

  if (dashboard && role === "employee") return <div className="page-enter mx-auto max-w-[1500px] space-y-6"><EmployeeDashboard assets={assignedAssets.assets} assetsLoading={assignedAssets.loading} assetsError={assignedAssets.error} requests={liveRequests} requestsReady={live} /></div>;

  return (
    <div className="page-enter mx-auto max-w-[1500px] space-y-6">
      <PageHeader
        eyebrow="People operations"
        title={role === "employee" ? "Employee" : "Employee support hub"}
        description={role === "employee" ? "" : "Resolve employee needs, publish notices, and audit service activity."}
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge tone={live ? "green" : "indigo"}>{live ? "Live API" : "API unavailable"}</Badge>
            {role === "employee" && tab === "Employee Requests" && <button className="primary-button" disabled={!live || loading} onClick={() => setRequestOpen(true)}><Plus size={16} />Raise Request</button>}
            {tab === "Employee Directory" ? <button className="primary-button" disabled={readOnly || !live || loading} onClick={() => { setCreatedEmployee(null); setDepartmentId(""); setEmployeeError(""); setEmployeeOpen(true); }}><UserPlus size={16} />Add User</button>
              : tab === "IT Announcements" && role !== "employee" ? <button className="secondary-button" disabled={readOnly || !live || loading} onClick={() => setAnnouncementOpen(true)}><Megaphone size={16} />Publish Announcement</button> : null}
          </div>
        }
      />
      {apiError && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{apiError} <button type="button" className="underline" disabled={loading} onClick={() => void loadEmployeeWorkspace(true)}>Retry</button></div>}
      {notice && <div role="status" className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-bold text-emerald-700"><span>{notice}</span><button onClick={() => setNotice("")}>Dismiss</button></div>}
      <div className="card px-2">
        <Tabs
          tabs={role === "employee" ? ["Employee Requests", "IT Announcements"] : ["Employee Directory", "Employee Requests", "IT Announcements", "Reports & Export", ...(canManageWorkload ? ["Admin counts"] : [])]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <ModuleWorkspace
        label="Employee Portal"
        sections={role === "employee" ? [] : ["Users", "Requests", "Announcements", "Reports", ...(canManageWorkload ? ["Admin counts"] : [])]}
        activeSection={tab === "Employee Directory" ? "Users" : tab === "Employee Requests" ? "Requests" : tab === "IT Announcements" ? "Announcements" : tab === "Admin counts" ? "Admin counts" : "Reports"}
        onSectionChange={(section) => setTab(section === "Users" ? "Employee Directory" : section === "Requests" ? "Employee Requests" : section === "Announcements" ? "IT Announcements" : section === "Admin counts" ? "Admin counts" : "Reports & Export")}
      >
        {tab === "Employee Directory" && <EmployeeDirectory onNotice={setNotice} />}
        {tab === "Employee Requests" && (
          <div className="space-y-5">
            {role === "employee" && <section aria-label="Warranty notifications" className="space-y-2 border-b pb-4"><h2 className="flex items-center gap-2 font-semibold"><BellRing size={16} />Warranty notifications</h2>{assignedAssets.loading ? <p role="status" className="text-sm">Loading warranty notifications...</p> : assignedAssets.error ? <p role="status" className="text-sm text-amber-700">{assignedAssets.error}</p> : assignedAssets.assets.some(asset => warrantyNotice(asset.warrantyExpiresAt)) ? <ul className="space-y-3">{assignedAssets.assets.map(asset => { const notice = warrantyNotice(asset.warrantyExpiresAt); return notice && <li key={asset.id} className="text-sm"><strong>{asset.name}</strong><p>{notice}</p></li>; })}</ul> : <p className="text-sm text-slate-500">No recorded warranties due within 30 days.</p>}</section>}
            {role === "employee" && <div className="flex gap-2" role="group" aria-label="Request view"><button className="secondary-button" aria-pressed={!requestHistory} onClick={() => setRequestHistory(false)}>Requests</button><button className="secondary-button" aria-pressed={requestHistory} onClick={() => setRequestHistory(true)}>Request history</button></div>}
            {role === "employee" && requestHistory && <section aria-label="Request history" className="space-y-3">{!requestItems.length && <p>No request history.</p>}{requestItems.map(item => <article key={item.id} className="border-b py-3"><h2 className="font-semibold">{item.ticketNumber || item.id} - {item.category}</h2><p className="text-sm">{item.issue}</p><p className="mt-2 text-xs">Created {new Date(item.createdAt).toLocaleString()} · {item.status === "Approved" ? "Resolved" : item.status} · {item.owner}</p><p className="text-xs">Updated {new Date(item.updatedAt).toLocaleString()}</p>{item.notes && <p className="mt-2 text-sm">{item.notes}</p>}{item.comments.map(comment => <p key={comment.id} className="mt-2 text-sm">{new Date(comment.createdAt).toLocaleString()} · {comment.author}: {comment.note}</p>)}</article>)}</section>}
            {!(role === "employee" && requestHistory) && <>
            <label className="block text-xs font-semibold">Search all requests<input type="search" className="field mt-1" value={requestSearch} onChange={(event) => setRequestSearch(event.target.value)} placeholder="Search today and older requests" /></label>
            <p className="text-xs text-slate-500">{requestQuery ? "Searching all request history." : "Showing requests created today (India time). Search to find older requests."}</p>
            <div className="flex flex-wrap gap-2">
              {[
                ["All", currentRequests.length],
                ["Pending", counts.Pending],
                ["Approved", counts.Approved],
                ["Rejected", counts.Rejected],
              ].map(([name, count]) => (
                <button
                  key={name}
                  onClick={() => setFilter(name as string)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-extrabold ${filter === name ? "border-brand-600 bg-brand-600 text-white" : "bg-white text-slate-500 dark:bg-slate-900"}`}
                >
                  {role === "employee" && name === "Approved" ? "Resolved" : name} ({live ? count : "-"})
                </button>
              ))}
            </div>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Total Requests"
                value={live ? String(currentRequests.length) : "-"}
                note="Current service window"
                icon={<TicketCheck size={19} />}
              />
              <MetricCard
                label="Action Pending"
                value={live ? String(counts.Pending) : "-"}
                note="Requires IT resolution"
                icon={<BellRing size={19} />}
                tone="amber"
              />
              <MetricCard
                label={role === "employee" ? "Resolved" : "Approved"}
                value={live ? String(counts.Approved) : "-"}
                note="Ready for fulfillment"
                icon={<Check size={19} />}
                tone="green"
              />
              <MetricCard
                label="Rejected"
                value={live ? String(counts.Rejected) : "-"}
                note="Closed with reason"
                icon={<X size={19} />}
                tone="rose"
              />
            </section>
            <div className="table-shell overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {[
                      "Ticket ID",
                      "Employee",
                      "Assignment",
                      "Request Category",
                      "Issue / Replacement Reason",
                      "Status",
                      "Action",
                    ].map((heading) => (
                      <th key={heading}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRequests.length === 0 ? <tr><td colSpan={7} className="py-10 text-center text-slate-500">{loading ? "Loading employee requests..." : live ? "No employee requests match this filter." : "Employee requests unavailable."}</td></tr> : visibleRequests.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs font-bold text-brand-600">
                        {row.ticketNumber || row.id}
                      </td>
                      <td className="font-bold">{row.employee}</td>
                      <td>{row.owner}</td>
                      <td>{row.category}</td>
                      <td className="max-w-xs text-slate-500">{row.issue}</td>
                      <td>
                        <Badge
                          tone={
                            row.status === "Approved"
                              ? "green"
                              : row.status === "Rejected"
                                ? "rose"
                                : "amber"
                          }
                        >
                          {role === "employee" && row.status === "Approved" ? "Resolved" : row.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex gap-2">
                          {!readOnly && (row.status === "Pending" || row.status === "In Progress") && (
                            <>
                              <button
                                onClick={() => void updateStatus(row, "resolved")}
                                className="text-xs font-bold text-emerald-600"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => void updateStatus(row, "rejected")}
                                className="text-xs font-bold text-rose-600"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => setSelectedRequest(row)}
                            className="text-xs font-bold text-brand-600"
                          >
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>}
          </div>
        )}
        {tab === "IT Announcements" && (
          <div className="grid gap-4 lg:grid-cols-3">
            {!liveAnnouncements.length && <p role="status">{loading ? "Loading announcements..." : live ? "No announcements returned." : "Announcements unavailable."}</p>}
            {liveAnnouncements.map((item) => ({ id: item.id, title: item.urgent ? "Urgent Notice" : "IT Notice", category: item.title, message: item.body, audience: item.audience, tone: item.urgent ? "rose" : "blue", createdAt: item.createdAt, author: item.authorName })).map((item) => (
              <article className="card p-5" key={item.id}>
                <div className="flex items-center justify-between">
                  <Badge tone={item.tone as "amber" | "blue" | "rose"}>
                    {item.title}
                  </Badge>
                  <span className="text-[10px] text-slate-400">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <h2 className="mt-5 font-extrabold">{item.category}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  {item.message}
                </p>
                <div className="mt-5 border-t pt-3 text-xs font-bold text-slate-400">
                  Audience · {item.audience} · {item.author}
                </div>
              </article>
            ))}
          </div>
        )}
        {tab === "Reports & Export" && (
          <div ref={logsRef} className="space-y-4">
            <section aria-label="Employee activity report" className="card bg-gradient-to-br from-blue-50 to-white p-5 dark:from-slate-900 dark:to-slate-950">
              <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-600">People operations · Activity report</p>
              <h2 className="mt-1 text-xl font-black">Employee support activity</h2>
              <p className="mt-1 text-xs text-slate-500">Generated {new Date().toLocaleString()} · {severity === "ALL" ? "All severities" : severity}{search.trim() ? ` · Search: ${search.trim()}` : ""}</p>
              <dl className="mt-5 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
                {[["Activity entries", visibleLogs.length], ["Tickets", reportTicketCount], ["People", reportEmployeeCount], ["Pending entries", reportPendingCount]].map(([label, value]) => <div key={label}><dt className="text-[10px] font-bold uppercase text-slate-500">{label}</dt><dd className="mt-1 text-xl font-black">{live ? value : "—"}</dd></div>)}
              </dl>
            </section>
            <div className="no-print card flex flex-col gap-3 p-4 xl:flex-row xl:items-center">
              <label className="relative flex-1">
                <Search
                  className="absolute left-3 top-3 text-slate-400"
                  size={17}
                />
                <input
                  className="field pl-10"
                  placeholder="Search logs"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-1">
                {["ALL", "INFO", "SUCCESS", "PENDING"].map((item) => (
                  <button
                    key={item}
                    onClick={() => setSeverity(item)}
                    className={`rounded px-3 py-2 text-[11px] font-extrabold ${severity === item ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500 dark:bg-slate-800"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button
                className="secondary-button"
                disabled={!live || loading || !visibleLogs.length || pdfBusy}
                onClick={() => void downloadActivityReport()}
              >
                <Download size={16} />
                {pdfBusy ? "Preparing PDF..." : "PDF"}
              </button>
              <button
                className="secondary-button"
                disabled={!live || loading || !visibleLogs.length}
                onClick={() =>
                  exportCsv("employee-support-logs.csv", [
                    [
                      "TIMESTAMP",
                      "TICKET ID",
                      "EMPLOYEE",
                      "EVENT",
                      "SEVERITY",
                      "STATUS",
                    ],
                    ...visibleLogs,
                  ])
                }
              >
                <FileSpreadsheet size={16} />
                CSV
              </button>
            </div>
            {pdfError && <p role="alert" className="no-print rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{pdfError}</p>}
            <div className="table-shell overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    {[
                      "Timestamp",
                      "Ticket ID",
                      "Employee",
                      "Action / Event Description",
                      "Severity",
                      "Status",
                    ].map((heading) => (
                      <th key={heading}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!visibleLogs.length && <tr><td colSpan={6} className="py-10 text-center text-slate-500">{loading ? "Loading employee activity..." : live ? "No employee activity matches these filters." : "Employee activity unavailable."}</td></tr>}
                  {visibleLogs.map((row) => (
                    <tr key={row[0] + row[1]}>
                      {row.map((cell, index) => (
                        <td
                          key={cell}
                          className={
                            index === 4
                              ? "font-bold text-brand-600"
                              : index === 3
                                ? "text-slate-500"
                                : ""
                          }
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === "Admin counts" && canManageWorkload && (
          <EmployeeWorkload
            tickets={requestItems}
            ticketsReady={live}
            onOpenTicket={setSelectedRequest}
          />
        )}
        {role === "employee" && requestOpen && <EmployeeRequestForm onClose={() => setRequestOpen(false)} onCreated={ticket => { setRequestOpen(false); setNotice(`Request ${ticket} sent to the IT / Admin team.`); setRequestHistory(true); void loadEmployeeWorkspace(); }} />}
        {selectedRequest && (
          <Modal
            title="Request details & resolution"
            onClose={() => setSelectedRequest(null)}
          >
            <div className="space-y-5 p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded bg-indigo-600 font-extrabold text-white">
                  {selectedRequest.employee
                    .split(" ")
                    .map((name) => name[0])
                    .join("")}
                </span>
                <div>
                  <h3 className="font-extrabold">{selectedRequest.employee}</h3>
                  <p className="font-mono text-xs">{selectedRequest.ticketNumber || selectedRequest.id}</p>
                  <p className="text-xs text-slate-500">
                    Assigned to {selectedRequest.owner} · Updated {new Date(selectedRequest.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="rounded-md border bg-slate-50 p-4 dark:bg-slate-950">
                <p className="text-xs font-extrabold uppercase text-slate-400">
                  {selectedRequest.category}
                </p>
                <p className="mt-3 text-sm leading-6">
                  {selectedRequest.issue}
                </p>
              </div>
              {selectedRequest.comments.length > 0 && <div><p className="mb-2 text-xs font-extrabold uppercase text-slate-400">Activity</p><div className="space-y-2">{selectedRequest.comments.map((comment) => <div key={comment.id} className="rounded-md border px-3 py-2 text-xs"><div className="flex justify-between gap-3"><strong>{comment.author}</strong><span className="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div><p className="mt-1 text-slate-500">{comment.note}</p></div>)}</div></div>}
              <div className="flex justify-end gap-2">
                <button
                  className="secondary-button text-rose-600"
                  onClick={() => void updateStatus(selectedRequest, "rejected")}
                  disabled={readOnly}
                >
                  <X size={16} />
                  Reject Ticket
                </button>
                <button
                  className="primary-button"
                  onClick={() => void updateStatus(selectedRequest, "resolved")}
                  disabled={readOnly}
                >
                  <Check size={16} />
                  Approve Replacement
                </button>
              </div>
            </div>
          </Modal>
        )}
        {employeeOpen && (
          <Modal title={createdEmployee ? "User added" : "Add user manually"} onClose={closeEmployeeModal}>
            {createdEmployee ? <div className="space-y-5 p-5">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"><p className="font-extrabold">{createdEmployee.username} is ready.</p><p className="mt-1 text-xs">Share the one-time password securely and require it to be changed after first login.</p></div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs font-bold text-slate-400">Email ID</dt><dd className="mt-1 font-semibold">{createdEmployee.email}</dd></div>
                <div><dt className="text-xs font-bold text-slate-400">Employee ID</dt><dd className="mt-1 font-semibold">{createdEmployee.employeeId}</dd></div>
                <div><dt className="text-xs font-bold text-slate-400">Department</dt><dd className="mt-1 font-semibold">{createdEmployee.department}</dd></div>
              </dl>
              <label className="block text-xs font-bold text-slate-500">One-time password<div className="mt-2 flex gap-2"><input className="field font-mono" readOnly value={createdEmployee.temporaryPassword} /><button type="button" className="secondary-button shrink-0" onClick={() => { void navigator.clipboard.writeText(createdEmployee.temporaryPassword); setNotice("One-time password copied."); }}><Copy size={16} />Copy</button></div></label>
              <div className="flex justify-end"><button className="primary-button" onClick={closeEmployeeModal}>Done</button></div>
            </div> : <form className="space-y-4 p-5" onSubmit={(event) => { event.preventDefault(); void createEmployee(event.currentTarget); }}>
              {employeeError && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{employeeError}</div>}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-bold text-slate-500">Full name<input className="field mt-2" name="username" required autoComplete="name" placeholder="Employee full name" /></label>
                <label className="text-xs font-bold text-slate-500">Email ID<input className="field mt-2" type="email" name="email" required autoComplete="email" placeholder="employee@company.com" /></label>
                <label className="text-xs font-bold text-slate-500">Employee ID<input className="field mt-2" name="employeeId" required maxLength={10} autoComplete="off" placeholder="EMP0001" /></label>
                <DepartmentMenu value={departmentId} departments={departments} loading={employeeLoading} onChange={setDepartmentId} />
              </div>
              <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800">Portal role: Employee. A strong one-time password will be generated automatically.</p>
              <div className="flex justify-end gap-2"><button type="button" className="secondary-button" onClick={closeEmployeeModal}>Cancel</button><button className="primary-button" disabled={employeeLoading || !departmentId}><UserPlus size={16} />{employeeLoading ? "Please wait..." : "Add User"}</button></div>
            </form>}
          </Modal>
        )}
        {announcementOpen && (
          <Modal
            title="Publish IT Announcement"
            onClose={() => setAnnouncementOpen(false)}
          >
            <form
              className="space-y-4 p-5"
              onSubmit={(event) => {
                event.preventDefault();
                void publishAnnouncement(event.currentTarget);
              }}
            >
              <label className="block text-xs font-bold text-slate-500">
                Title
                <input
                  className="field mt-2"
                  name="title"
                  required
                  placeholder="Announcement title"
                />
              </label>
              <label className="block text-xs font-bold text-slate-500">
                Priority
                <select className="field mt-2" name="priority">
                  <option>Maintenance Window</option>
                  <option>Policy Update</option>
                  <option>Urgent Notice</option>
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-500">
                Target Audience
                <select className="field mt-2" name="audience">
                  <option>All Employees</option>
                  <option>IT Team</option>
                  <option>Admin</option>
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-500">
                Message
                <textarea className="field mt-2 h-28 py-3" name="message" required />
              </label>
              <div className="flex justify-end">
                <button className="primary-button">
                  <Megaphone size={16} />
                  Publish Notice
                </button>
              </div>
            </form>
          </Modal>
        )}
      </ModuleWorkspace>
    </div>
  );
}
