// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The setup state the wizard reads, field for field as docs/spec/setup-api.md
// states it (GET /os/semanto/{id}/setup). These are written out here, not
// imported from src/, because the dashboard talks only to the public API
// (docs/ARCHITECTURE.md, the web/ row). A field marked optional is absent,
// not null, when it does not apply, the way the spec says.

export type SetupStep = "company" | "prove" | "read" | "review" | "install" | "done";

export type ProofStatus = "waiting" | "found_wrong_value" | "found" | "proved";

export type DiagnosisState = "not_started" | "looking" | "propagating" | "doubled_name" | "wrong_value" | "old_value" | "proven" | "timed_out" | "claimed_elsewhere";

export interface Diagnosis {
  state: DiagnosisState;
  tone: "idle" | "working" | "done" | "attention" | "stopped";
  title: string;
  detail: string;
  fix?: string;
  keep_looking: boolean;
  resolvers: { resolver: string; found: string[] }[];
}

export interface ProofState {
  record_type: "TXT";
  record_name: string;
  name_to_type: string;
  record_value: string;
  status: ProofStatus;
  checked_at: string | null;
  next_check_at: string | null;
  proven_at: string | null;
  method: "dns_txt" | "well_known" | null;
  provider: { id: string; name: string; domain_connect_url?: string; manual_steps: string[] };
  diagnosis: Diagnosis;
  well_known: { url: string; body: string };
  pointer: { record_name: string; record_value: string | null };
}

export type LeftOutCode = "noindex" | "robots" | "not_found" | "server_error" | "login" | "personal" | "duplicate" | "too_large" | "not_reached" | "not_html" | "other";

export interface ReadState {
  status: "queued" | "reading" | "done" | "failed";
  held: boolean;
  found: number;
  read: number;
  pages_done: number;
  left_out: { url: string; reason: string; code: LeftOutCode }[];
  eta_seconds?: number;
  started_at: string | null;
  finished_at?: string;
  error?: string;
  version: number | null;
}

export interface ReviewState {
  version: number | null;
  root_hash: string | null;
  changed_since_read: boolean;
  changed_urls: string[];
  facts_count: number;
  pages_count: number;
  saved_for_later: boolean;
  confirmed_at: string | null;
}

export interface SignState {
  custody: "hosted" | "customer";
  passkey_required: boolean;
  /** The signed-in person has a passkey on file; hosted signing needs one. */
  has_passkey: boolean;
  two_officer: boolean;
  /** With hosted custody, only approvals made with a passkey are listed (passkey true). */
  approvals: { name: string; role: string; at: string; passkey?: boolean }[];
  signed_version: number | null;
  signed_at: string | null;
}

export type HostKind = "cloudflare" | "vercel" | "netlify" | "fastly" | "akamai" | "gcore" | "nginx" | "apache" | "wordpress" | "shopify" | "webflow" | "squarespace" | "wix" | "head_tag" | "unknown";

export type CheckState = "pass" | "fail" | "pending";

export interface InstallChecks {
  markdown: CheckState;
  signature: CheckState;
  well_known: CheckState;
}

export interface InstallState {
  host: HostKind;
  guide_id: string;
  detected_at: string | null;
  checks: InstallChecks;
  message: string;
  checked_at: string | null;
}

export interface MonitoringState {
  started_at: string | null;
  questions: string[];
  competitors: { name: string; domain: string }[];
  suggested_questions: string[];
}

export interface StepTiming {
  id: string;
  target_seconds: number;
  spent_seconds: number | null;
  within_target: boolean | null;
}

export interface Timings {
  steps: StepTiming[];
  basic: { target_seconds: number; spent_seconds: number | null; within_target: boolean | null };
  full: { target_seconds: number; spent_seconds: number | null; within_target: boolean | null };
  not_started: string[];
}

export interface NextAction {
  label: string;
  method: "GET" | "POST";
  url: string;
}

export interface SetupState {
  object: "semanto.setup";
  trooth_id: string | null;
  org: string | null;
  domain: string | null;
  step: SetupStep;
  basic: boolean;
  saved_for_later: boolean;
  proof: ProofState | null;
  read: ReadState | null;
  review: ReviewState | null;
  sign: SignState | null;
  install: InstallState | null;
  monitoring: MonitoringState | null;
  timings: Timings;
  next_action: NextAction | null;
  checked_at: string;
}

export interface ReviewFact {
  id: string;
  key: string;
  statement: string;
  value: string | null;
  provenance: "witnessed" | "public_record" | "attested" | "declared";
  source_url: string;
  source_title: string | null;
}

export interface ReviewDocument {
  object: "semanto.setup_review";
  trooth_id: string;
  version: number | null;
  root_hash: string | null;
  changed_since_read: boolean;
  changed_urls: string[];
  sections: { id: "company" | "products" | "contact" | "policies"; title: string; facts: ReviewFact[] }[];
  pages: { id: string; url: string; title: string | null }[];
}

export interface InstallCheckAnswer {
  object: "semanto.install_check";
  url: string;
  checks: InstallChecks;
  messages: { markdown: string; signature: string; well_known: string };
  message: string;
  checked_at: string;
  setup: SetupState;
}

/** A WebAuthn descriptor in JSON form: the id is base64url (W3C WebAuthn Level 3, 5.10.3). */
export interface CredentialDescriptorJSON {
  type: "public-key";
  id: string;
  transports?: string[];
}

/** POST /os/semanto/{id}/passkeys/options: PublicKeyCredentialCreationOptions in JSON form (src/identity/webauthn.ts). */
export interface PasskeyOptionsAnswer {
  object: "semanto.passkey_options";
  trooth_id: string;
  expires_at: string;
  has_passkey: boolean;
  publicKey: {
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    challenge: string;
    pubKeyCredParams: { type: "public-key"; alg: number }[];
    timeout: number;
    excludeCredentials: CredentialDescriptorJSON[];
    authenticatorSelection: { residentKey: "preferred"; requireResidentKey: boolean; userVerification: "required" };
    attestation: "none";
  };
}

/** POST /os/semanto/{id}/passkeys. */
export interface PasskeyAdded {
  object: "semanto.passkey";
  trooth_id: string;
  credential_id: string;
  alg: number;
  transports: string[];
  created_at: string;
}

/** POST /os/semanto/{id}/sign/options: PublicKeyCredentialRequestOptions bound to one version and root hash. */
export interface SignOptionsAnswer {
  object: "semanto.sign_options";
  trooth_id: string;
  version: number;
  root_hash: string;
  expires_at: string;
  publicKey: { challenge: string; rpId: string; allowCredentials: CredentialDescriptorJSON[]; userVerification: "required"; timeout: number };
}

/** POST /os/semanto/{id}/sign, every answer the pipeline gives (src/pipeline.ts sign). */
export type SignAnswer =
  | { object: "semanto.signed"; trooth_id: string; version: number; version_id: string; root_hash: string; signed_at: string; kid: string }
  | { object: "semanto.sign_waiting"; trooth_id: string; version: number; root_hash: string; reason: string; approvals_missing: number; two_officer_note?: string }
  | { object: "semanto.signing_input"; trooth_id: string; version: number; kid: string; typ: string; signing_input: string; protected: string; payload: string; next: string };

export interface Competitor {
  name: string;
  domain: string;
}

/** The six screens of docs/audit/workflow-research.md section 5. */
export type ScreenId = "A" | "B" | "C" | "D" | "E" | "F";
