import { useCallback, useEffect, useRef, useState } from "react";
import { usePortalReadOnly } from "../lib/portalAccess";
import JsBarcode from "jsbarcode";
import {
  Box,
  Clock3,
  Download,
  FileCheck2,
  Plus,
  RefreshCw,
  Send,
} from "lucide-react";
import { Badge, MetricCard, Modal, PageHeader, Tabs } from "../components/ui";
import { exportCsv, exportElementPdf } from "../lib/exports";
import { GatepassRecordPicker, type GatepassChoice } from "./GatepassRecordPicker";
import { subscribeRecordChanges } from "../lib/recordChanges";

interface RecordOption {
  kind: string; id: string; name: string; entityId: string; locationId: string;
  reference: string; serial: string; department: string; role: string;
  assignedUserId?: string;
}
interface RecordSnapshot {
  version: number;
  sender: { entityId: string; name: string; source: string };
  receiver: { entityId: string; name: string; source: string };
  asset: RecordOption; origin: RecordOption; destination: RecordOption;
  recipient: RecordOption; approver: RecordOption; returnDate: string;
}

function PrintableGatepass({
  gatepassNumber,
  assetId,
  assetName,
  assetSerial,
  assetDepartment,
  receiver,
  fromBranch,
  toBranch,
  phone,
  passType,
  approver,
  dispatchDate,
  returnDate,
  purpose,
  senderCompany,
  receiverCompany,
  official,
}: {
  gatepassNumber: string;
  assetId: string;
  assetName: string;
  assetSerial: string;
  assetDepartment: string;
  receiver: string;
  fromBranch: string;
  toBranch: string;
  phone: string;
  passType: string;
  approver: string;
  dispatchDate: string;
  returnDate: string;
  purpose: string;
  senderCompany: string;
  receiverCompany: string;
  official: boolean;
}) {
  const barcodeRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (barcodeRef.current)
      JsBarcode(barcodeRef.current, gatepassNumber, {
        format: "CODE128",
        width: 1.65,
        height: 48,
        displayValue: true,
        fontSize: 13,
        margin: 4,
      });
  }, [gatepassNumber]);
  return (
    <div id="printable-gatepass-doc" className="bg-white p-7 text-slate-900">
      <div className="flex items-start justify-between border-b-2 border-slate-900 pb-5">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[.2em] text-blue-700">
            {senderCompany || "Company not recorded"}
          </p>
          <h2 className="mt-2 text-2xl font-extrabold">
            {official ? "OFFICIAL HARDWARE GATEPASS" : "INCOMPLETE GATEPASS — NOT FOR MOVEMENT"}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Hardware movement document · Handwritten signatures required
          </p>
        </div>
        <div className="text-right">
          <strong>{gatepassNumber}</strong>
          <p className="text-xs text-slate-500">Issue date: {dispatchDate || "Not recorded"}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6 py-5 text-sm">
        <div>
          <p className="text-[10px] font-extrabold uppercase text-slate-400">
            Sender
          </p>
          <strong>{senderCompany || "Company not recorded"}</strong>
          <p>{fromBranch}</p>
        </div>
        <div>
          <p className="text-[10px] font-extrabold uppercase text-slate-400">
            Receiver
          </p>
          <strong>{receiverCompany || "Company not recorded"}</strong>
          <p>Recipient: {receiver || "Not recorded"}</p>
          <p>{toBranch}</p>
          <p>{phone || "Contact pending"}</p>
        </div>
      </div>
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="bg-slate-100">
            <th className="border p-2">Asset ID</th>
            <th className="border p-2">Item / Hardware</th>
            <th className="border p-2">Serial Number</th>
            <th className="border p-2">Department</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border p-2 font-bold">{assetId}</td>
            <td className="border p-2">{assetName}</td>
            <td className="border p-2">{assetSerial || "Not recorded"}</td>
            <td className="border p-2">{assetDepartment || "Not recorded"}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-5 grid grid-cols-3 gap-4 text-xs">
        <div>
          <span className="text-slate-400">Pass Type</span>
          <strong className="block">{passType}</strong>
        </div>
        <div>
          <span className="text-slate-400">Dispatch Date</span>
          <strong className="block">{dispatchDate || "Not recorded"}</strong>
        </div>
        <div>
          <span className="text-slate-400">Expected Return</span>
          <strong className="block">{returnDate || "Not recorded"}</strong>
        </div>
      </div>
      <div className="mt-5 rounded border p-3 text-xs">
        <span className="text-slate-400">Purpose of Movement</span>
        <p className="mt-1 font-semibold">
          {purpose || "Not recorded"}
        </p>
      </div>
      <div className="mt-7 grid grid-cols-3 gap-4" aria-label="Handwritten signatures">
        {["IT Team Approver", "Security Checkpoint", "Receiver / Employee"].map(role => (
          <div key={role} className="text-center text-[10px]" style={{ breakInside: "avoid" }}>
            <div aria-label={`${role} signature space`} className="h-20 border-b border-slate-500" />
            <strong className="mt-2 block text-xs">{role}</strong>
            <p>Signature (sign by hand)</p>
            <p className="mt-3 text-left">Name: __________________</p>
            <p className="mt-3 text-left">Date: ___________________</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs">Designated IT approver: {approver || "Not recorded"}. A printed name or system approval is not a signature.</p>
      <div className="mt-7 flex justify-center">
        <svg ref={barcodeRef} />
      </div>
      <p className="mt-4 text-center text-[9px] text-slate-400">
        Generated by ITMS. Print and sign by hand before movement. Validate the
        barcode at the security checkpoint. No electronic signature is applied.
      </p>
    </div>
  );
}

interface GatepassRecord {
  recordSnapshot?: RecordSnapshot;
  id: string;
  gatepassNumber: string;
  assetRef: string;
  assetDescription: string;
  purpose: string;
  originBranch: string;
  recipientBranch: string;
  issueDate: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string;
  contactNumber: string;
  status: string;
  createdAt: string;
  approverName: string;
  requesterName: string;
  receiverSignedName: string;
  securitySignedName: string;
  hasReceiverSignedUpload: boolean;
}

interface GatepassAudit {
  id: string;
  createdAt: string;
  action: string;
  summary: string;
  actor: { fullName?: string };
  entityId?: string;
}

interface GatepassView extends GatepassRecord {
  displayStatus: string;
}

async function gatepassRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Gatepass API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function GatepassPage() {
  const readOnly = usePortalReadOnly();
  const [tab, setTab] = useState("Gatepass Dashboard");
  const [createOpen, setCreateOpen] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [options, setOptions] = useState<RecordOption[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const recordsRequest = useRef(0);
  const [originId, setOriginId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [receiverEntityId, setReceiverEntityId] = useState("");
  const [senderEntityId, setSenderEntityId] = useState("");
  const [approverId, setApproverId] = useState("");
  const automaticRecipient = useRef(true);
  const automaticApprover = useRef(true);
  const [snapshot, setSnapshot] = useState<RecordSnapshot>();
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const statusUpdateLock = useRef(false);
  const generation = useRef(0);
  const [receiver, setReceiver] = useState("");
  const [fromBranch, setFromBranch] = useState("");
  const [toBranch, setToBranch] = useState("");
  const [phone, setPhone] = useState("");
  const [approver, setApprover] = useState("");
  const [dispatchDate, setDispatchDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [notice, setNotice] = useState("");
  const [livePasses, setLivePasses] = useState<GatepassRecord[]>([]);
  const [auditRows, setAuditRows] = useState<GatepassAudit[]>([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [completionPass, setCompletionPass] = useState<GatepassView | null>(null);
  const [receiverSigner, setReceiverSigner] = useState("");
  const [securitySigner, setSecuritySigner] = useState("");
  const [signaturesConfirmed, setSignaturesConfirmed] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const completionLock = useRef(false);
  const [gatepassNumber, setGatepassNumber] = useState("Draft");
  const [recordSearch, setRecordSearch] = useState("");
  const pendingRecordSearch = useRef("");
  const [documentAsset, setDocumentAsset] = useState({ name: "", serial: "", department: "" });
  const isDraft = gatepassNumber === "Draft";
  const selected = (kind: string, id: string) => options.find(item => item.kind === kind && item.id === id);
  const recordKeywords = (item: RecordOption) => {
    const company = selected("entity", item.entityId);
    return [item.id, item.name, item.reference, item.serial, item.department, company?.name, company?.reference, company?.reference === "ZTEC" ? "ZTECH" : ""].join(" ");
  };
  const choicesFor = (items: RecordOption[], display: (item: RecordOption) => string = item => item.name): GatepassChoice[] => items.map(item => ({
    id: item.id, display: display(item), keywords: recordKeywords(item),
    label: [display(item), item.name, item.reference, selected("entity", item.entityId)?.name].filter((part, index, parts) => part && parts.indexOf(part) === index).join(" · "),
  }));
  const asset = selected("asset", assetId);
  const origin = selected("branch", originId);
  const destination = selected("branch", destinationId);
  const recipient = selected("recipient", recipientId);
  function selectAsset(id: string, records = options) {
    if (id === assetId && records === options) return;
    const findRecord = (kind: string, recordId: string) => records.find(item => item.kind === kind && item.id === recordId);
    const next = findRecord("asset", id);
    const branch = findRecord("branch", next?.locationId || "");
    setAssetId(id);
    setSenderEntityId(current => next && current && next.entityId !== current ? "" : current);
    setOriginId(branch && branch.entityId === next?.entityId ? branch.id : "");
    if (automaticRecipient.current) {
      const person = findRecord("recipient", next?.assignedUserId || "");
      const recipientBranch = findRecord("branch", person?.locationId || "");
      setRecipientId(person?.id || "");
      setDestinationId(recipientBranch && recipientBranch.entityId === person?.entityId ? recipientBranch.id : "");
      setReceiverEntityId("");
      setPhone("");
    }
    if (automaticApprover.current) {
      const candidates = records.filter(item => item.kind === "recipient" && item.entityId === next?.entityId &&
        ["admin", "super_admin", "it_team"].includes(item.role));
      setApproverId(candidates.length === 1 ? candidates[0].id : "");
    }
  }
  function searchRecords(value: string, records = options) {
    pendingRecordSearch.current = value;
    setRecordSearch(value);
    const query = value.trim().toLowerCase();
    if (!query) return;
    const matches = records.filter(item => item.kind === "asset" &&
      [item.id, item.reference, item.serial, item.name].some(field => field.trim().toLowerCase() === query));
    if (matches.length === 1) selectAsset(matches[0].id, records);
  }
  const senderCompanyId = asset?.entityId || origin?.entityId || senderEntityId;
  const senderCompany = isDraft ? selected("entity", senderCompanyId)?.name || "" : snapshot?.sender.name || "";
  const receiverCompanyId = recipient?.entityId || destination?.entityId || receiverEntityId;
  const receiverCompany = isDraft ? selected("entity", receiverCompanyId)?.name || "" : snapshot?.receiver.name || "";
  const conflict = Boolean((origin && asset && origin.entityId !== asset.entityId) ||
    (recipient && destination && recipient.entityId !== destination.entityId) ||
    (receiverEntityId && receiverCompanyId !== receiverEntityId));
  const official = !isDraft && snapshot?.version === 1 && Boolean(senderCompany && receiverCompany);
  const companies = choicesFor(options.filter(item => item.kind === "entity"));
  const availableAssets = options.filter(item => item.kind === "asset" && (!senderEntityId || item.entityId === senderEntityId));
  function selectSenderCompany(id: string) {
    if (((asset && asset.entityId !== id) || (origin && origin.entityId !== id)) &&
      !window.confirm("Changing the sender company will clear incompatible asset or branch selections. Continue?")) return;
    if (asset && asset.entityId !== id) selectAsset("");
    if (origin?.entityId !== id) setOriginId("");
    setSenderEntityId(id);
    setRecordSearch("");
  }
  function selectReceiverCompany(id: string) {
    if (((recipient && recipient.entityId !== id) || (destination && destination.entityId !== id)) &&
      !window.confirm("Changing the receiver company will clear incompatible recipient or branch selections. Continue?")) return;
    automaticRecipient.current = false;
    if (recipient?.entityId !== id) { setRecipientId(""); setPhone(""); }
    if (destination?.entityId !== id) setDestinationId("");
    setReceiverEntityId(id);
    setRecordSearch("");
  }
  function selectRecipient(id: string) {
    automaticRecipient.current = false;
    const next = selected("recipient", id);
    const branch = selected("branch", next?.locationId || "");
    setRecipientId(id); setPhone("");
    setDestinationId(next ? branch?.entityId === next.entityId ? branch.id : destination?.entityId === next.entityId ? destination.id : "" : "");
  }
  const documentRef = useRef<HTMLDivElement>(null);
  const printProps = {
    gatepassNumber,
    assetId: isDraft ? asset?.reference || "" : assetId,
    assetName: isDraft ? asset?.name || "" : documentAsset.name,
    assetSerial: isDraft ? asset?.serial || "" : documentAsset.serial,
    assetDepartment: isDraft ? asset?.department || "" : documentAsset.department,
    receiver: isDraft ? recipient?.name || "" : receiver,
    fromBranch: isDraft ? origin?.name || "" : fromBranch,
    toBranch: isDraft ? destination?.name || "" : toBranch,
    phone,
    passType: purpose,
    approver: isDraft ? selected("recipient", approverId)?.name || "" : approver,
    dispatchDate,
    returnDate,
    purpose,
    senderCompany, receiverCompany, official,
  };
  const loadGatepassWorkspace = useCallback(async () => {
    const token = localStorage.getItem("itms_token");
    const requestGeneration = ++generation.current;
    if (!token) { setLoading(false); setLive(false); setLivePasses([]); setAuditRows([]); setOptions([]); setCreateOpen(false); setCompletionPass(null); return; }
    setLoading(true);
    try {
      const [gatepassData, auditData] = await Promise.all([
        gatepassRequest<GatepassRecord[] | { items: GatepassRecord[] }>("/gatepass", token),
        gatepassRequest<GatepassAudit[]>("/audit?entity_type=gatepass", token),
      ]);
      if (requestGeneration !== generation.current || token !== localStorage.getItem("itms_token")) return;
      setLivePasses(Array.isArray(gatepassData) ? gatepassData : gatepassData.items);
      setAuditRows(auditData);
      setLive(true);
      setApiError("");
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      setApiError(error instanceof Error ? error.message : "Gatepass workspace unavailable");
      setLive(false);
      setLivePasses([]); setAuditRows([]);
    } finally { if (requestGeneration === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { void loadGatepassWorkspace(); }, [loadGatepassWorkspace]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !createOpen && !completionPass && !saving && !completing && !loading && !statusUpdateLock.current) void loadGatepassWorkspace();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadGatepassWorkspace, createOpen, completionPass, saving, completing, loading]);
  useEffect(() => {
    const invalidate = () => { generation.current++; };
    const reload = () => { setCreateOpen(false); setCompletionPass(null); setOptions([]); setLivePasses([]); void loadGatepassWorkspace(); };
    window.addEventListener("itms-auth-changed", reload);
    return () => { invalidate(); window.removeEventListener("itms-auth-changed", reload); };
  }, [loadGatepassWorkspace]);
  const generatePdf = () => {
    if (!official) return;
    const element = documentRef.current?.querySelector<HTMLElement>(
      "#printable-gatepass-doc",
    );
    if (element) exportElementPdf(element, `${gatepassNumber}-full-gatepass.pdf`);
  };
  const passItems: GatepassView[] = live ? livePasses.map(item => ({ ...item, displayStatus: item.status })) : [];

  async function updatePass(item: GatepassView, action: "approve" | "reject") {
    if (readOnly || statusUpdateLock.current) return;
    const token = localStorage.getItem("itms_token");
    if (!token) {
      setApiError("Connect your ITMS account to update gatepasses.");
      return;
    }
    statusUpdateLock.current = true;
    try {
      await gatepassRequest(`/gatepass/${item.id}/${action}`, token, { method: "PUT" });
      setNotice(`${item.gatepassNumber} ${action === "approve" ? "approved" : "rejected"}.`);
      await loadGatepassWorkspace();
    } catch (error) { setApiError(error instanceof Error ? error.message : "Gatepass status could not be updated"); }
    finally { statusUpdateLock.current = false; }
  }

  function openCompletion(item: GatepassView) {
    if (readOnly) return;
    setCompletionPass(item); setReceiverSigner(""); setSecuritySigner("");
    setSignaturesConfirmed(false); setCompletionError("");
  }

  async function recordCompletion() {
    if (readOnly) return;
    if (!completionPass || completionLock.current || !signaturesConfirmed || !receiverSigner.trim() || !securitySigner.trim()) return;
    const token = localStorage.getItem("itms_token");
    if (!token) { setCompletionError("Sign in to record handwritten sign-off."); return; }
    completionLock.current = true; setCompleting(true); setCompletionError("");
    try {
      await gatepassRequest(`/gatepass/${completionPass.id}/complete`, token, { method: "POST", body: JSON.stringify({ receiverSignedName: receiverSigner.trim(), securitySignedName: securitySigner.trim() }) });
      setNotice(`${completionPass.gatepassNumber} completed after confirmation of handwritten signatures. No electronic signature was created.`);
      setCompletionPass(null);
      await loadGatepassWorkspace();
    } catch (error) {
      setCompletionError(`${error instanceof Error ? error.message : "Completion could not be recorded"}. Check the gatepass list before retrying; no automatic retry was performed.`);
    } finally { completionLock.current = false; setCompleting(false); }
  }

  function viewGatepass(item: GatepassView) {
    const saved = item.recordSnapshot?.version === 1 ? item.recordSnapshot : undefined;
    setSnapshot(saved);
    setAssetId(saved?.asset.reference || item.assetRef);
    setDocumentAsset(saved?.asset || { name: item.assetDescription || item.assetRef, serial: "", department: item.departmentName });
    setGatepassNumber(item.gatepassNumber);
    setReceiver(saved ? saved.recipient.name : item.employeeName);
    setFromBranch(saved ? saved.origin.name : item.originBranch);
    setToBranch(saved ? saved.destination.name : item.recipientBranch);
    setPhone(item.contactNumber);
    setApprover(saved ? saved.approver.name : item.approverName);
    setDispatchDate(item.issueDate);
    setReturnDate(saved?.returnDate || "");
    setPurpose(item.purpose);
    setCreateOpen(true);
  }

  async function openDraft() {
    if (readOnly) return;
    const token = localStorage.getItem("itms_token");
    if (!token) return;
    setOptions([]); setSnapshot(undefined); setAssetId(""); setOriginId(""); setDestinationId("");
    setSenderEntityId("");
    setRecipientId(""); setReceiverEntityId(""); setApproverId(""); setPurpose("");
    automaticRecipient.current = true; automaticApprover.current = true;
    setPhone(""); setDispatchDate(""); setReturnDate(""); setApprover("");
    setGatepassNumber("Draft"); setCreateOpen(true); setApiError("");
    setRecordSearch("");
    pendingRecordSearch.current = "";
    const items = await loadRecordOptions();
    if (items) searchRecords(pendingRecordSearch.current, items);
  }

  const loadRecordOptions = useCallback(async () => {
    const token = localStorage.getItem("itms_token");
    if (!token) return;
    const requestGeneration = generation.current;
    const request = ++recordsRequest.current;
    setRecordsLoading(true); setApiError("");
    try {
      const data = await gatepassRequest<{ items: RecordOption[] }>("/gatepass/options", token);
      if (request === recordsRequest.current && requestGeneration === generation.current && token === localStorage.getItem("itms_token")) {
        setOptions(data.items);
        return data.items;
      }
    } catch (error) {
      if (request === recordsRequest.current && requestGeneration === generation.current && token === localStorage.getItem("itms_token")) setApiError(error instanceof Error ? error.message : "Saved records unavailable");
    } finally {
      if (request === recordsRequest.current) setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!createOpen || !isDraft) return;
    return subscribeRecordChanges(() => { if (!saveLock.current) void loadRecordOptions(); });
  }, [createOpen, isDraft, loadRecordOptions]);

  async function createGatepass() {
    if (readOnly) return;
    if (saveLock.current || conflict || !asset || !origin || !senderCompany || !receiverCompany || !approverId || !dispatchDate || !purpose.trim()) return;
    const token = localStorage.getItem("itms_token");
    if (!token) {
      setApiError("Connect your ITMS account to create a gatepass.");
      return;
    }
    saveLock.current = true; setSaving(true);
    const requestGeneration = generation.current;
    try {
      const created = await gatepassRequest<{ id: string; gatepassNumber: string }>("/gatepass", token, { method: "POST", body: JSON.stringify({ assetId, originBranchId: originId, recipientBranchId: destinationId, recipientId, receiverEntityId, approverId, purpose: purpose.trim(), issueDate: dispatchDate, returnDate, contactNumber: phone }) });
      if (requestGeneration !== generation.current || token !== localStorage.getItem("itms_token")) return;
      setCreateOpen(false);
      setNotice(`${created.gatepassNumber} created and queued for approval.`);
      await loadGatepassWorkspace();
    } catch (error) { if (requestGeneration === generation.current) setApiError(`${error instanceof Error ? error.message : "Gatepass could not be created"}. Check the list before retrying; no automatic retry was performed.`); }
    finally { saveLock.current = false; setSaving(false); }
  }

  return (
    <div className="page-enter mx-auto max-w-[1500px] space-y-6">
      <PageHeader
        eyebrow="Asset movement"
        title="Digital hardware gatepass"
        description="Authorize, track, and audit enterprise hardware movement."
        actions={<div className="flex items-center gap-2"><button className="primary-button" disabled={readOnly || !live} onClick={() => void openDraft()}><Plus size={17} />Create Gatepass</button></div>}
      />
      {apiError && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{apiError} {!live && <button type="button" className="ml-2 underline" disabled={loading} onClick={() => void loadGatepassWorkspace()}>Retry loading gatepasses</button>}</div>}
      {notice && <div role="status" className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-bold text-emerald-700"><span>{notice}</span><button onClick={() => setNotice("")}>Dismiss</button></div>}
      <div className="card px-2">
        <Tabs
          tabs={["Gatepass Dashboard", "Pending Approvals", "Reports & Audit"]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active Gatepasses"
          value={String(passItems.filter((item) => item.status === "approved").length)}
          note="Currently outside premises"
          icon={<FileCheck2 size={19} />}
        />
        <MetricCard
          label="Pending Approvals"
          value={String(passItems.filter((item) => item.status === "pending").length)}
          note="Awaiting IT authorization"
          icon={<Clock3 size={19} />}
          tone="amber"
        />
        <MetricCard
          label="Completed"
          value={String(passItems.filter((item) => item.status === "completed").length)}
          note="Completion recorded"
          icon={<Send size={19} />}
          tone="indigo"
        />
        <MetricCard
          label="Returnable Pending"
          value={String(passItems.filter((item) => item.status === "approved" && item.purpose.toLowerCase().includes("return")).length)}
          note="Approved returnable movement"
          icon={<Box size={19} />}
          tone="rose"
        />
      </section>
      {tab === "Reports & Audit" && (
        <div className="flex justify-end">
          <button
            className="secondary-button"
            onClick={() =>
              exportCsv("gatepass-audit.csv", [
                [
                  "Gatepass ID",
                  "Item",
                  "Requested By",
                  "Type",
                  "Destination",
                  "Status",
                ],
                ...passItems.map((item) => [
                  item.gatepassNumber,
                  item.assetDescription,
                  item.employeeName || item.requesterName,
                  item.purpose,
                  item.recipientBranch,
                  item.displayStatus,
                ]),
              ])
            }
          >
            <Download size={16} />
            Export Audit CSV
          </button>
        </div>
      )}
      <div className="table-shell overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {[
                "Gatepass ID",
                "Item / Hardware Details",
                "Requested By",
                "Pass Type",
                "Destination / Carrier",
                "Status",
                "Action",
              ].map((heading) => (
                <th key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {passItems
              .filter(
                (item) => tab !== "Pending Approvals" || item.status === "pending",
              )
              .map((item) => (
                <tr key={item.id}>
                  <td className="font-mono text-xs font-bold text-brand-600">
                    {item.gatepassNumber}
                  </td>
                  <td>
                    <strong className="block">{item.assetDescription || item.assetRef}</strong>
                    <small className="text-slate-500">{item.assetRef}</small>
                  </td>
                  <td>{item.employeeName || item.requesterName}</td>
                  <td>{item.purpose}</td>
                  <td>{item.recipientBranch}</td>
                  <td>
                    <Badge
                      tone={
                        item.status === "approved"
                          ? "green"
                          : item.status === "pending"
                            ? "amber"
                            : item.status === "rejected" ? "rose" : "blue"
                      }
                    >
                      {item.displayStatus}
                    </Badge>
                  </td>
                  <td>
                    <div className="flex gap-2">{!readOnly && item.status === "pending" && <><button className="text-xs font-bold text-emerald-600" onClick={() => void updatePass(item, "approve")}>Approve</button><button className="text-xs font-bold text-rose-600" onClick={() => void updatePass(item, "reject")}>Reject</button></>}{!readOnly && item.status === "approved" && <button className="text-xs font-bold text-indigo-600" onClick={() => openCompletion(item)}>Complete</button>}<button className="text-xs font-bold text-brand-600" onClick={() => viewGatepass(item)}>View / PDF</button></div>
                  </td>
                </tr>
              ))}
              {passItems.filter((item) => tab !== "Pending Approvals" || item.status === "pending").length === 0 && <tr><td colSpan={7} className="py-10 text-center text-slate-500">No gatepasses match this view.</td></tr>}
          </tbody>
        </table>
      </div>
      {tab === "Reports & Audit" && <section className="space-y-3"><div><h2 className="font-extrabold">Gatepass audit trail</h2><p className="text-xs text-slate-500">Authenticated creation, approval, rejection, upload, and completion events</p></div><div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{["Timestamp", "Actor", "Action", "Summary", "Gatepass ID"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{auditRows.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString()}</td><td>{entry.actor.fullName || "System"}</td><td className="font-bold">{entry.action.replaceAll("_", " ")}</td><td>{entry.summary}</td><td className="font-mono text-xs text-brand-600">{entry.entityId || ""}</td></tr>)}</tbody></table></div></section>}
      {createOpen && (
        <Modal
          title={isDraft ? "Create hardware gatepass from saved records" : `Saved gatepass · ${gatepassNumber}`}
          onClose={() => setCreateOpen(false)}
          size="max-w-5xl"
        >
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
            <form
              className="min-w-0 space-y-5 border-r p-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (isDraft) void createGatepass();
                else generatePdf();
              }}
            >
              {apiError && <p role="alert" className="text-sm text-rose-700">{apiError}</p>}
              {!isDraft && !official && <p role="alert">Company snapshots were not recorded for this historical pass. Official export is blocked; current master data cannot verify historical companies.</p>}
              <p className="text-xs">Type a company name to see matching saved companies, then select one. Selecting an asset, recipient or branch can also detect its saved company.</p>
              <fieldset disabled={!isDraft || saving} className="grid min-w-0 gap-4 sm:grid-cols-2">
                {isDraft && <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <a href="/settings" target="_blank" rel="noopener noreferrer" className="secondary-button" title="Open company, branch and asset entry in Settings (super administrator)"><Plus size={16} />Add company, branch or asset</a>
                  <button type="button" className="secondary-button" disabled={recordsLoading} onClick={() => void loadRecordOptions()}><RefreshCw size={16} />{recordsLoading ? "Loading records..." : "Refresh saved records"}</button>
                </div>}
                {isDraft && <div className="sm:col-span-2"><GatepassRecordPicker label="Search saved companies and assets" value="" search={recordSearch} onSearch={searchRecords}
                  choices={options.filter(item => item.kind === "asset" || item.kind === "entity").map(item => ({ id: `${item.kind}:${item.id}`, display: item.name, label: `${item.kind === "asset" ? "Asset" : "Company"}: ${[item.reference, item.name].filter(Boolean).join(" · ")}`, keywords: recordKeywords(item) }))}
                  onSelect={id => { const item = options.find(record => `${record.kind}:${record.id}` === id); if (item?.kind === "asset") selectAsset(item.id); else if (item?.kind === "entity") selectSenderCompany(item.id); searchRecords(""); }}
                  placeholder="Company, code, asset tag or serial" /></div>}
                {isDraft ? <GatepassRecordPicker label="Company Sender" value={senderCompanyId} choices={companies} onSelect={selectSenderCompany} describedBy="gatepass-sender-source" suggestionsOnTyping /> : <label className="text-xs font-bold text-slate-500">
                  Company Sender
                  <input
                    className="field mt-2 bg-slate-50"
                    value={senderCompany}
                    placeholder={isDraft ? "Select an asset to detect company" : "Company not recorded"}
                    aria-describedby="gatepass-sender-source"
                    readOnly
                  />
                </label>}
                {isDraft ? <GatepassRecordPicker label="Receiver Company" value={receiverCompanyId} choices={companies} onSelect={selectReceiverCompany} describedBy="gatepass-receiver-source" suggestionsOnTyping /> : <label className="text-xs font-bold text-slate-500">
                  Receiver Company
                  <input
                    className="field mt-2"
                    value={receiverCompany}
                    placeholder={isDraft ? "Select recipient or destination" : "Company not recorded"}
                    aria-describedby="gatepass-receiver-source"
                    readOnly
                  />
                </label>}
                <p id="gatepass-sender-source" className="text-xs text-slate-500" role="status">
                  {!isDraft ? "Sender company from the saved gatepass snapshot." : senderCompany ? asset ? "Sender company detected from the selected asset." : origin ? "Sender company detected from the origin branch." : "Sender company selected from saved records." : asset ? "The asset's saved company is unavailable. Correct its company record before creating a gatepass." : "No sender company selected."}
                </p>
                <p id="gatepass-receiver-source" className="text-xs text-slate-500" role="status">
                  {!isDraft ? "Receiver company from the saved gatepass snapshot." : conflict ? "Conflicting company records: correct the selections before creating a gatepass." : receiverCompany ? recipient ? "Receiver company detected from the selected recipient." : destination ? "Receiver company detected from the destination branch." : "Receiver company explicitly selected from authorized records." : "No receiver company detected. Select a saved recipient, destination branch or authorized company."}
                </p>
                {isDraft ? <GatepassRecordPicker label="From Branch" value={originId} choices={choicesFor(options.filter(item => item.kind === "branch" && (!senderCompanyId || item.entityId === senderCompanyId)))} onSelect={setOriginId} /> : <label className="text-xs font-bold text-slate-500">From Branch<input className="field mt-2" value={fromBranch} readOnly /></label>}
                {isDraft ? <GatepassRecordPicker label="To Branch" value={destinationId} choices={choicesFor(options.filter(item => item.kind === "branch" && (!receiverEntityId || item.entityId === receiverEntityId)))} onSelect={id => { automaticRecipient.current = false; setDestinationId(id); }} /> : <label className="text-xs font-bold text-slate-500">To Branch<input className="field mt-2" value={toBranch} readOnly /></label>}
                {isDraft ? <GatepassRecordPicker label="Recipient (person)" value={recipientId} choices={choicesFor(options.filter(item => item.kind === "recipient" && (!receiverEntityId || item.entityId === receiverEntityId)))} onSelect={selectRecipient} /> : <label className="text-xs font-bold text-slate-500">Recipient (person)<input className="field mt-2" value={receiver} readOnly /></label>}
                <label className="text-xs font-bold text-slate-500">
                  Contact Phone
                  <input
                    className="field mt-2"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    maxLength={50}
                  />
                </label>
                {isDraft ? <GatepassRecordPicker label="Asset ID" value={assetId} choices={choicesFor(availableAssets, item => item.reference)} onSelect={selectAsset} /> : <label className="text-xs font-bold text-slate-500">Asset ID<input className="field mt-2" value={assetId} readOnly /></label>}
                {isDraft ? <GatepassRecordPicker label="Item Name" value={assetId} choices={choicesFor(availableAssets)} onSelect={selectAsset} /> : <label className="text-xs font-bold text-slate-500">
                  Item Name
                  <input
                    className="field mt-2 bg-slate-50"
                    value={isDraft ? asset?.name || "" : documentAsset.name}
                    readOnly
                  />
                </label>}
                {isDraft ? <GatepassRecordPicker label="Serial Number" value={assetId} choices={choicesFor(availableAssets.filter(item => item.serial), item => item.serial)} onSelect={selectAsset} /> : <label className="text-xs font-bold text-slate-500">
                  Serial Number
                  <input
                    className="field mt-2 bg-slate-50"
                    value={isDraft ? asset?.serial || "" : documentAsset.serial}
                    readOnly
                  />
                </label>}
                {isDraft ? <GatepassRecordPicker label="Department" value={assetId} choices={choicesFor(availableAssets.filter(item => item.department), item => item.department)} onSelect={selectAsset} /> : <label className="text-xs font-bold text-slate-500">
                  Department
                  <input
                    className="field mt-2 bg-slate-50"
                    value={isDraft ? asset?.department || "" : documentAsset.department}
                    readOnly
                  />
                </label>}
                {isDraft ? <GatepassRecordPicker label="IT Approver" value={approverId} choices={choicesFor(options.filter(item => item.kind === "recipient" && ["admin", "super_admin", "it_team"].includes(item.role)))} onSelect={id => { automaticApprover.current = false; setApproverId(id); }} /> : <label className="text-xs font-bold text-slate-500">IT Approver<input className="field mt-2" value={approver} readOnly /></label>}
                <label className="text-xs font-bold text-slate-500">
                  Dispatch Date
                  <input
                    type="date"
                    className="field mt-2"
                    value={dispatchDate}
                    required
                    onChange={(event) => setDispatchDate(event.target.value)}
                  />
                </label>
                <label className="text-xs font-bold text-slate-500">
                  Expected Return Date
                  <input
                    type="date"
                    className="field mt-2"
                    value={returnDate}
                    onChange={(event) => setReturnDate(event.target.value)}
                  />
                </label>
              </fieldset>
              {conflict && <p role="alert">Company mappings conflict. Select matching authorized records; no company will be guessed.</p>}
              <label className="block text-xs font-bold text-slate-500">
                Purpose of Movement
                <textarea
                  className="field mt-2 h-24 py-3"
                  value={purpose}
                  readOnly={!isDraft}
                  required
                  maxLength={4000}
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </label>
              <p className="rounded-md border p-3 text-xs text-slate-500">Print the PDF and obtain handwritten signatures from the IT approver, security officer and receiver. Approval in ITMS does not sign the document.</p>
              <button className="primary-button w-full" disabled={isDraft ? saving || conflict || !asset || !origin || !senderCompany || !receiverCompany || !approverId || !dispatchDate || !purpose.trim() : !official}>
                <Download size={16} />
                {isDraft ? saving ? "Saving…" : "Create Gatepass" : `Download ${gatepassNumber} PDF`}
              </button>
            </form>
            <div
              ref={documentRef}
              className="min-w-0 overflow-x-auto bg-slate-100 p-4 dark:bg-slate-950"
            >
              <div className="mb-3 flex justify-end">
                <button
                  className="secondary-button bg-white"
                  onClick={generatePdf}
                  disabled={!official}
                >
                  <Download size={16} />
                  Download Full Gatepass PDF
                </button>
              </div>
              <div className="origin-top scale-[.92] shadow-xl">
                <PrintableGatepass {...printProps} />
              </div>
            </div>
          </div>
        </Modal>
      )}
      {completionPass && <Modal title={`Record handwritten sign-off · ${completionPass.gatepassNumber}`} onClose={() => { if (!completing) setCompletionPass(null); }}>
        <form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); void recordCompletion(); }}>
          <p className="text-sm">Collect the signatures on the printed gatepass first. Enter the names written on that document; these fields do not create electronic signatures.</p>
          {completionError && <p role="alert" className="text-sm text-rose-700">{completionError}</p>}
          <fieldset disabled={completing} className="space-y-4">
            <label className="block text-sm font-semibold">Receiver signatory name<input className="field mt-2" value={receiverSigner} maxLength={150} required onChange={event => setReceiverSigner(event.target.value)} /></label>
            <label className="block text-sm font-semibold">Security signatory name<input className="field mt-2" value={securitySigner} maxLength={150} required onChange={event => setSecuritySigner(event.target.value)} /></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={signaturesConfirmed} onChange={event => setSignaturesConfirmed(event.target.checked)} />I confirm that the IT approver, security officer and receiver have signed the printed gatepass by hand.</label>
            <div className="flex justify-end gap-2"><button type="button" className="secondary-button" onClick={() => setCompletionPass(null)}>Cancel</button><button className="primary-button" disabled={completing || !signaturesConfirmed || !receiverSigner.trim() || !securitySigner.trim()}>{completing ? "Recording…" : "Record completion"}</button></div>
          </fieldset>
        </form>
      </Modal>}
    </div>
  );
}
