import { useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { useBridge } from "../hooks/useBridge";
import { didFromAccount, getCurrentAccount } from "../lib/auth";
import type { SessionSummary } from "../lib/bridge";
import { pushToast } from "../hooks/useToast";

const STORAGE_KEY = "zkdid.access-form";

type Form = { hospitalDid: string; granteeDid: string; recordId: string };
function loadForm(): Form {
  try { return { hospitalDid: "", granteeDid: "", recordId: "", ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { hospitalDid: "", granteeDid: "", recordId: "" }; }
}

export function AccessPage({ session }: { session: SessionSummary | null }) {
  const [form, setForm] = useState<Form>(loadForm);
  const { createAccess, busy } = useBridge();
  const account = getCurrentAccount();
  const patientDid = account ? didFromAccount(account) : null;
  const hasSession = session?.hasSession === true && !session.expired;

  const update = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const submit = async () => {
    const missing = Object.entries(form).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length) {
      pushToast("warning", `Missing: ${missing.join(", ")}`);
      return;
    }
    await createAccess(form);
  };

  const useSelfAsHospital = () => {
    if (patientDid) update({ hospitalDid: patientDid });
  };
  const useSelfAsGrantee = () => {
    if (patientDid) update({ granteeDid: patientDid });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">EHR Access Grant</h1>
        <p className="mt-1 text-slate-400">
          Publish an <code className="font-mono-tight text-slate-300">AccessGrant</code> to the <code className="font-mono-tight text-slate-300">medical_access</code> contract. The patient (you, as signer) authorizes a grantee to access a specific record at a hospital.
        </p>
      </div>

      {!hasSession && (
        <Card>
          <div className="flex items-start gap-3">
            <span className="shrink-0 text-amber-400 text-xl leading-none">!</span>
            <div className="text-sm text-slate-300">
              No valid session. Log in first — AccessGrants are signed as the patient zkLogin address.
            </div>
          </div>
        </Card>
      )}

      <Card title="Grant details" subtitle="Patient DID is taken from your current session.">
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2.5 text-sm">
            <span className="text-xs text-slate-500 uppercase tracking-wide">Patient DID</span>
            <div className="mt-1 font-mono-tight text-slate-200 break-all">{patientDid ?? "— log in first —"}</div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={<>Hospital DID <button onClick={useSelfAsHospital} className="ml-2 text-xs text-indigo-400 hover:text-indigo-300">(use self)</button></>}
              placeholder="did:zklogin:google:0x..."
              value={form.hospitalDid}
              onChange={(e) => update({ hospitalDid: e.target.value })}
              hint="The institution that holds the record."
            />
            <Field
              label={<>Grantee DID <button onClick={useSelfAsGrantee} className="ml-2 text-xs text-indigo-400 hover:text-indigo-300">(use self)</button></>}
              placeholder="did:zklogin:google:0x..."
              value={form.granteeDid}
              onChange={(e) => update({ granteeDid: e.target.value })}
              hint="The party being granted access."
            />
          </div>

          <Field
            label="Record ID"
            placeholder="record-1234 or a VC hash"
            value={form.recordId}
            onChange={(e) => update({ recordId: e.target.value })}
            hint="Free-form identifier for the medical record."
          />

          <div className="flex flex-wrap gap-3 pt-2">
            <Button
              variant="primary"
              size="lg"
              loading={busy === "Create Access Grant"}
              disabled={!hasSession || !!busy}
              onClick={submit}
            >
              Create AccessGrant
            </Button>
            <Button variant="ghost" onClick={() => { setForm({ hospitalDid: "", granteeDid: "", recordId: "" }); localStorage.removeItem(STORAGE_KEY); }}>
              Clear form
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Contract target" subtitle="Calls on current Sui DevNet">
        <dl className="text-sm grid gap-1 font-mono-tight text-slate-300">
          <div className="flex gap-2"><dt className="text-slate-500 w-44">Module</dt><dd>medical_access::medical_access</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-44">Function</dt><dd>create_access_grant</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-44">Args</dt><dd>patient_did, hospital_did, grantee_did, record_id, timestamp</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-44">Signer</dt><dd>you (zkLogin, via backend)</dd></div>
        </dl>
      </Card>
    </div>
  );
}
