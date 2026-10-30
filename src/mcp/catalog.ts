// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// THE SEMANTO MCP TOOLS: every part of Semanto an agent can run, one tool per action, named and
// annotated the way the MCP specification and the clients that read it expect (modelcontextprotocol.io,
// specification 2026-07-28, server/tools: title, inputSchema, and the hints readOnlyHint, destructiveHint,
// idempotentHint, openWorldHint, set on every tool rather than left to their conservative defaults).
// Clients act on readOnlyHint: Claude, ChatGPT, Cursor and Codex run a read-only tool without asking, and
// ask before the rest, so the reads are on by default and every change waits for the person.
//
// Each tool is one call to a route the dashboard already uses (docs/spec/os-api.md, docs/spec/setup-api.md),
// so an agent and a person meet the same checks, roles, rate limits and audit trail. Access:
//   public   no key; anyone may call it
//   read     an agent key of either scope (it acts as a viewer)
//   write    an agent key with scope write (it acts as an admin)
//   person   never an agent: the tool answers human_action_required with the page where a person finishes
//            it (signing needs the signer's passkey; erasing, two-officer signing and agent keys are a
//            person's decision). This is the MCP URL-mode elicitation pattern, given as a link every client can show.

export type Access = "public" | "read" | "write" | "person";

export interface ToolParam {
  type: "string" | "integer" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
  items?: Record<string, unknown>;
}

export interface SemantoTool {
  name: string;
  title: string;
  category: string;
  description: string;
  access: Access;
  /** The route, with {trooth_id}, {kid}, {run_id}, {n} filled from the arguments. Absent for person tools. */
  method?: "GET" | "POST";
  path?: string;
  /** Arguments read into the query string (GET) or the JSON body (POST); path arguments are taken out first. */
  params: Record<string, ToolParam>;
  required?: string[];
  /** POST tools that take the route's own body: the whole `body` argument is sent as JSON. */
  freeBody?: boolean;
  /** For person tools: the dashboard page where the person finishes it. */
  page?: string;
  hints: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const ID: ToolParam = { type: "string", description: "The company's Trooth ID, for example acme. Leave it out to use the company the agent key belongs to." };
const KID: ToolParam = { type: "string", description: "The key id (kid), from semanto_keys_get or semanto_connectors_list." };
const CONFIRM_KID: ToolParam = { type: "string", description: "The same kid again, to confirm." };
const CURSOR: ToolParam = { type: "string", description: "The cursor from the previous page's answer, to read the next page." };
const CONFIRM_TRUE: ToolParam = { type: "boolean", description: "true, to confirm this change." };
const IDEMPOTENCY: ToolParam = { type: "string", description: "A new random value of 8 to 200 letters, digits or . _ : - for each send, so a retried call never sends twice." };
const BODY: ToolParam = { type: "object", description: "The request body the route takes, as described in this tool's description." };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ADD_OPEN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SET_OPEN = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DESTROY_OPEN = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const os = (p: string) => `/os/semanto/{trooth_id}${p}`;
const pub = (p: string) => `/public/semanto${p}`;
const DASH = "https://trooth.co/dashboard/semanto";

export const SEMANTO_TOOLS: SemantoTool[] = [
  // ---------------------------------------------------------------- start here
  { name: "semanto_whoami", title: "Who this key acts for", category: "Start here", access: "read", description: "The company, scope and role this agent key acts with, and the MCP address. Call it first.", params: {}, hints: READ },
  { name: "semanto_status", title: "Setup status and next step", category: "Start here", access: "read", method: "GET", path: os("/setup"), description: "Where the company is in setup (prove, read, review, install, done), each step's state, the timings, and next_action: the one call to make next. Every setup tool answers this same object after its change.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_guide", title: "How to finish setup", category: "Start here", access: "public", description: "What Semanto is and the order an agent runs it in, with which steps need the person. Read it once before running setup for someone.", params: {}, hints: READ },

  // ---------------------------------------------------------------- setup
  { name: "semanto_setup_look_again", title: "Read the domain's proof again", category: "Setup", access: "write", method: "POST", path: os("/setup/look-again"), description: "Reads the domain's state on trooth.co again now, after the person confirmed the domain there.", params: { trooth_id: ID }, hints: SET },
  { name: "semanto_setup_read_again", title: "Read the website again", category: "Setup", access: "write", method: "POST", path: os("/setup/read-again"), description: "Queues a new read of the company's website. Held until the domain is proven.", params: { trooth_id: ID }, hints: ADD_OPEN },
  { name: "semanto_setup_choose", title: "Choose Basic or the full signed copy", category: "Setup", access: "write", method: "POST", path: os("/setup/choose"), description: "Completes the receipt step. basic keeps the company on Semanto Basic; full moves it to the signed copy of the whole site.", params: { trooth_id: ID, path: { type: "string", enum: ["basic", "full"], description: "basic or full." } }, required: ["path"], hints: SET },
  { name: "semanto_review_get", title: "The facts to review", category: "Setup", access: "read", method: "GET", path: os("/setup/review"), description: "The newest built version's facts, for the person to review before it is signed: each fact with its source page.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_setup_confirm", title: "Confirm the reviewed version", category: "Setup", access: "write", method: "POST", path: os("/setup/confirm"), description: "Confirms the version the person reviewed. root_hash must be the newest build's, or the answer says the version changed while it was being reviewed.", params: { trooth_id: ID, version: { type: "integer", description: "The version number from semanto_review_get." }, root_hash: { type: "string", description: "sha256:<64 hex>, from semanto_review_get." } }, required: ["version", "root_hash"], hints: SET },
  { name: "semanto_setup_host", title: "Set where the site is hosted", category: "Setup", access: "write", method: "POST", path: os("/setup/host"), description: "Sets the host the install guide is for, when detection got it wrong.", params: { trooth_id: ID, host: { type: "string", enum: ["cloudflare", "vercel", "netlify", "fastly", "akamai", "gcore", "nginx", "apache", "wordpress", "shopify", "webflow", "squarespace", "wix", "head_tag"], description: "The host." } }, required: ["host"], hints: SET },
  { name: "semanto_detect_host", title: "Detect the site's host", category: "Setup", access: "write", method: "POST", path: os("/detect"), description: "Reads the live site and its DNS to tell which host serves it, and stores the answer for the install step.", params: { trooth_id: ID }, hints: SET_OPEN },
  { name: "semanto_setup_save_for_later", title: "Save setup for later", category: "Setup", access: "write", method: "POST", path: os("/setup/save-for-later"), description: "Marks setup as saved for later; everything done so far is kept.", params: { trooth_id: ID, screen: { type: "string", description: "Optional: the screen to come back to, A to F." } }, hints: SET },
  { name: "semanto_setup_resume", title: "Resume setup", category: "Setup", access: "write", method: "POST", path: os("/setup/resume"), description: "Takes setup off saved for later.", params: { trooth_id: ID }, hints: SET },
  { name: "semanto_basic_claim", title: "Basic: the domain's state", category: "Setup", access: "write", method: "POST", path: os("/basic/claim"), description: "Semanto Basic: the domain's state on trooth.co and the steps left. Nothing is published.", params: { trooth_id: ID, domain: { type: "string", description: "Optional: the domain, as on trooth.co." } }, hints: SET },
  { name: "semanto_basic_prove", title: "Basic: record the domain proof", category: "Setup", access: "write", method: "POST", path: os("/basic/prove"), description: "When the domain is confirmed on trooth.co, records the proof and queues the read.", params: { trooth_id: ID }, hints: SET },

  // ---------------------------------------------------------------- build, sign and publish
  { name: "semanto_build", title: "Build a new version", category: "Build and publish", access: "write", method: "POST", path: os("/build"), description: "Reads the site and builds a new version to review and sign. Queued; follow it with semanto_status.", params: { trooth_id: ID }, hints: ADD_OPEN },
  { name: "semanto_sign", title: "Sign and publish (the person)", category: "Build and publish", access: "person", page: `${DASH}/sign`, description: "Signing publishes the version under the company's key, so it takes the signer's passkey. Answers the page where the person signs; nothing is signed by this call. Confirm the version first with semanto_setup_confirm.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_first_publication", title: "Record a first publication", category: "Build and publish", access: "write", method: "POST", path: os("/first-publication"), freeBody: true, description: "Records that the company published a piece of content first, signed and logged, so later copies can be told apart. body: the fields of the dashboard's First publication form, starting with url.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: ADD_OPEN },
  { name: "semanto_withdraw", title: "Withdraw a version", category: "Build and publish", access: "write", method: "POST", path: os("/withdraw"), description: "Withdraws a signed version: it answers 410 from then on and the withdrawal is logged. Cannot be undone.", params: { trooth_id: ID, version: { type: "integer", description: "The version to withdraw." }, reason: { type: "string", description: "Plain words, required." } }, required: ["version", "reason"], hints: DESTROY },
  { name: "semanto_versions_list", title: "List published versions", category: "Build and publish", access: "public", method: "GET", path: pub("/{trooth_id}/versions"), description: "Every version the company published, newest first, with its state (signed, withdrawn, superseded).", params: { trooth_id: { ...ID, description: "The company's Trooth ID." } }, required: ["trooth_id"], hints: READ },
  { name: "semanto_version_get", title: "Read one version", category: "Build and publish", access: "public", method: "GET", path: pub("/{trooth_id}/versions/{n}"), description: "One published version's Semanto file, signed.", params: { trooth_id: { ...ID, description: "The company's Trooth ID." }, n: { type: "integer", description: "The version number." } }, required: ["trooth_id", "n"], hints: READ },

  // ---------------------------------------------------------------- put it on the site
  { name: "semanto_install_guide", title: "How to put it on the site", category: "Put it on the site", access: "read", description: "The install for the company's host: what to deploy or paste, every value filled in, and the API calls an agent with that host's own tools makes. For Cloudflare, the Worker and the two Cloudflare API calls that deploy it without GitHub.", params: { trooth_id: ID, host: { type: "string", description: "Optional: a host, to read another host's guide." } }, hints: READ },
  { name: "semanto_install_check", title: "Check my site", category: "Put it on the site", access: "write", method: "POST", path: os("/setup/install-check"), description: "Runs the three checks on the live site (markdown on request, the signature, the two well-known files) and answers each as passed or not, with what to change.", params: { trooth_id: ID }, hints: SET_OPEN },

  // ---------------------------------------------------------------- delivery settings
  { name: "semanto_settings_get", title: "Delivery settings", category: "Delivery settings", access: "read", method: "GET", path: os("/settings"), description: "How the signed copy is served: content signals, the pages served, the mode.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_settings_preview", title: "Preview delivery settings", category: "Delivery settings", access: "write", method: "POST", path: os("/settings/preview"), freeBody: true, description: "What a settings change would do, without saving it. body: the DeliverySettings object, as semanto_settings_get answers it.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: READ },
  { name: "semanto_settings_save", title: "Save delivery settings", category: "Delivery settings", access: "write", method: "POST", path: os("/settings"), freeBody: true, description: "Saves the delivery settings. body: the DeliverySettings object. Preview first.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET },

  // ---------------------------------------------------------------- keys
  { name: "semanto_keys_get", title: "Signing keys and domain binding", category: "Keys", access: "read", method: "GET", path: os("/keys"), description: "The company's signing keys with their state (next, active, retiring, revoked) and whether the current key is bound to the domain by its _trooth-keys DNS record.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_keys_binding_check", title: "Check the key's DNS binding", category: "Keys", access: "write", method: "POST", path: os("/keys/binding/check"), description: "Reads the _trooth-keys DNS record now and answers whether it binds the current key.", params: { trooth_id: ID }, hints: SET_OPEN },
  { name: "semanto_keys_rotation_start", title: "Start a key rotation (the person)", category: "Keys", access: "person", page: `${DASH}/keys`, description: "Rotating the signing key changes what signs for the company, so a person starts it and confirms it with their passkey. Answers the page where they do it.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_keys_rotation_confirm", title: "Confirm a key rotation (the person)", category: "Keys", access: "person", page: `${DASH}/keys`, description: "Confirming a rotation takes the signer's passkey. Answers the page where the person confirms it.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_keys_rotation_cancel", title: "Cancel a key rotation", category: "Keys", access: "write", method: "POST", path: os("/keys/rotation/cancel"), description: "Cancels a started rotation before it is confirmed.", params: { trooth_id: ID, rotation_id: { type: "string", description: "The rotation id from semanto_keys_rotation_start." } }, required: ["rotation_id"], hints: DESTROY },
  { name: "semanto_key_revoke", title: "Revoke a signing key (the person)", category: "Keys", access: "person", page: `${DASH}/keys`, description: "Revoking a signing key cannot be undone, so a person does it by typing the key id. Answers the page where they do it.", params: { trooth_id: ID }, hints: READ },

  // ---------------------------------------------------------------- who read it
  { name: "semanto_receipts_list", title: "Who read the signed copy", category: "Readers", access: "read", method: "GET", path: os("/receipts"), description: "Read receipts: which agents read which pages, when, and whether they proved who they are (Web Bot Auth). Filters are optional.", params: { trooth_id: ID, from: { type: "string", description: "First day, YYYY-MM-DD." }, to: { type: "string", description: "Last day, YYYY-MM-DD." }, agent: { type: "string", description: "Only this agent." }, path: { type: "string", description: "Only this page path." }, status: { type: "string", description: "Only this status." }, cursor: CURSOR, limit: { type: "integer", description: "Rows a page." } }, hints: READ },
  { name: "semanto_receipts_csv", title: "Read receipts as CSV", category: "Readers", access: "read", method: "GET", path: os("/receipts.csv"), description: "The same receipts as RFC 4180 CSV, for a spreadsheet.", params: { trooth_id: ID, from: { type: "string", description: "First day, YYYY-MM-DD." }, to: { type: "string", description: "Last day, YYYY-MM-DD." } }, hints: READ },
  { name: "semanto_benchmarks", title: "Network benchmarks", category: "Readers", access: "public", method: "GET", path: pub("/benchmarks"), description: "Reads across every company on the network over the last 30 days, by agent and kind of page, under CC BY 4.0.", params: {}, hints: READ },

  // ---------------------------------------------------------------- connector keys (apps that read on the company's behalf)
  { name: "semanto_connectors_list", title: "Connector keys", category: "Connectors", access: "read", method: "GET", path: os("/connectors"), description: "The keys apps use to sign requests for this company (Web Bot Auth), with when each was last used.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_connector_create", title: "Make a connector key", category: "Connectors", access: "write", method: "POST", path: os("/connectors/create"), description: "Makes a connector key held by Trooth for an app.", params: { trooth_id: ID, source: { type: "string", description: "The app the key is for." }, label: { type: "string", description: "Optional name." } }, required: ["source"], hints: ADD },
  { name: "semanto_connector_add", title: "Add a connector's public key", category: "Connectors", access: "write", method: "POST", path: os("/connectors"), description: "Adds an app's own public key (a JWK) as a connector.", params: { trooth_id: ID, public_jwk: { type: "object", description: "The public JWK." }, label: { type: "string", description: "Optional name." }, source: { type: "string", description: "Optional app name." } }, required: ["public_jwk"], hints: ADD },
  { name: "semanto_connector_test", title: "Test a connector key", category: "Connectors", access: "write", method: "POST", path: os("/connectors/{kid}/test"), description: "Answers from the last signed request made with this key whether it checked out.", params: { trooth_id: ID, kid: KID }, required: ["kid"], hints: SET_OPEN },
  { name: "semanto_connector_revoke", title: "Revoke a connector key", category: "Connectors", access: "write", method: "POST", path: os("/connectors/{kid}/revoke"), description: "Revokes a connector key; the app can no longer sign for the company.", params: { trooth_id: ID, kid: KID, confirm: CONFIRM_KID }, required: ["kid", "confirm"], hints: DESTROY },
  { name: "semanto_connect_approve", title: "Approve an app (the person)", category: "Connectors", access: "person", page: `${DASH}/connectors`, description: "Letting another app act for the company is a person's decision. Answers the page where they approve or deny it.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_connect_deny", title: "Deny an app (the person)", category: "Connectors", access: "person", page: `${DASH}/connectors`, description: "Denying an app's request is a person's decision. Answers the page where they approve or deny it.", params: { trooth_id: ID }, hints: READ },

  // ---------------------------------------------------------------- Google
  { name: "semanto_google_status", title: "Google connection", category: "Google", access: "read", method: "GET", path: os("/google"), description: "Whether Google Merchant Center and Business Profile are connected, and what was last sent.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_google_connect", title: "Connect Google (the person)", category: "Google", access: "person", page: `${DASH}/connections`, description: "Connecting Google is the person signing in to Google and approving access. Answers the page where they do it.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_google_disconnect", title: "Disconnect Google", category: "Google", access: "write", method: "POST", path: os("/google/disconnect"), description: "Revokes Trooth's Google access and forgets the tokens. Write-back to Google stops until a person connects again.", params: { trooth_id: ID, confirm: CONFIRM_TRUE }, required: ["confirm"], hints: DESTROY_OPEN },

  // ---------------------------------------------------------------- write-back: sending the signed facts to listings
  { name: "semanto_writeback_preview", title: "Preview what would be sent to listings", category: "Listings", access: "read", method: "GET", path: os("/writeback"), description: "What the signed facts would change on each connected listing (Google and others), item by item. Nothing is sent.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_writeback_send", title: "Send to listings", category: "Listings", access: "write", method: "POST", path: os("/writeback/send"), description: "Sends the chosen items to the connected listings and records the run. Leave item_ids out to send every change the preview can send. Use a new idempotency_key for each send; sending the same key again answers the same run.", params: { trooth_id: ID, confirm: CONFIRM_TRUE, idempotency_key: IDEMPOTENCY, item_ids: { type: "array", items: { type: "string" }, description: "item_id values from semanto_writeback_preview." } }, required: ["confirm", "idempotency_key"], hints: ADD_OPEN },
  { name: "semanto_writeback_runs", title: "Past sends to listings", category: "Listings", access: "read", method: "GET", path: os("/writeback/runs"), description: "Runs, 20 a page, newest first.", params: { trooth_id: ID, cursor: CURSOR }, hints: READ },
  { name: "semanto_writeback_run_get", title: "One send to listings", category: "Listings", access: "read", method: "GET", path: os("/writeback/runs/{run_id}"), description: "One run, item by item.", params: { trooth_id: ID, run_id: { type: "string", description: "The run id." } }, required: ["run_id"], hints: READ },
  { name: "semanto_writeback_retry", title: "Retry failed sends", category: "Listings", access: "write", method: "POST", path: os("/writeback/runs/{run_id}/retry"), description: "Sends a run's failed items again.", params: { trooth_id: ID, run_id: { type: "string", description: "The run id." }, item_ids: { type: "array", items: { type: "string" }, description: "The failed item ids. Leave it out to send every failed item again." } }, required: ["run_id"], hints: ADD_OPEN },
  { name: "semanto_listings_check", title: "Check listings against the signed copy", category: "Listings", access: "write", method: "POST", path: os("/monitor/run"), freeBody: true, description: "Compares the live pages, Google listings and feeds with the signed record now, including Content Signals drift. body: {} for all surfaces.", params: { trooth_id: ID, body: BODY }, hints: SET_OPEN },

  // ---------------------------------------------------------------- commerce
  { name: "semanto_seller_lists", title: "Authorized seller lists", category: "Commerce", access: "read", method: "GET", path: os("/sellers/lists"), description: "The signed lists of who may sell the company's products.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_seller_list_options", title: "Prepare a seller list", category: "Commerce", access: "write", method: "POST", path: os("/sellers/lists/options"), freeBody: true, description: "Prepares a seller list for signing. body: { draft }. Publishing it is signed by the person (semanto_sign).", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET },
  { name: "semanto_recalls", title: "Recalls", category: "Commerce", access: "read", method: "GET", path: os("/recalls"), description: "The company's published recalls, newest first.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_recall_options", title: "Prepare a recall", category: "Commerce", access: "write", method: "POST", path: os("/recalls/options"), freeBody: true, description: "Prepares a recall notice for signing. body: { notice } with skus and the words. Publishing it is signed by the person.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET },
  { name: "semanto_credentials", title: "Content credentials (C2PA)", category: "Commerce", access: "read", method: "GET", path: os("/credentials"), description: "The C2PA content credentials made for the company's images and documents, 50 a page.", params: { trooth_id: ID, state: { type: "string", description: "Optional state filter." }, cursor: CURSOR }, hints: READ },

  // ---------------------------------------------------------------- reports
  { name: "semanto_reports", title: "Reports", category: "Reports", access: "read", method: "GET", path: os("/reports"), description: "The newest gap report: what AI answers about the company that the signed record does not support.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_competitor_report", title: "Compare with competitors", category: "Reports", access: "write", method: "POST", path: os("/competitor-report"), description: "How the company's signed facts compare with up to three competitors' public pages.", params: { trooth_id: ID, kind: { type: "string", enum: ["local", "shopping"], description: "local or shopping." }, competitors: { type: "array", items: { type: "object" }, description: "1 to 3 of { name, domain }." } }, required: ["kind", "competitors"], hints: ADD_OPEN },
  { name: "semanto_lei", title: "Add the LEI", category: "Reports", access: "write", method: "POST", path: os("/lei"), freeBody: true, description: "Adds the company's Legal Entity Identifier, checked against GLEIF. body: { lei }.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET_OPEN },

  // ---------------------------------------------------------------- company settings
  { name: "semanto_company_get", title: "Company settings", category: "Company", access: "read", method: "GET", path: os("/company"), description: "The company's signing policy, surfaces and alert addresses.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_company_surfaces", title: "Set the surfaces", category: "Company", access: "write", method: "POST", path: os("/company/surfaces"), freeBody: true, description: "Sets which surfaces (site, listings, feeds) the company keeps in step. body: as semanto_company_get answers surfaces.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET },
  { name: "semanto_company_alerts", title: "Set alert addresses", category: "Company", access: "write", method: "POST", path: os("/company/alerts"), freeBody: true, description: "Changes one alert address at a time; each new address confirms by email. body: { \"add\": address }, { \"resend\": address } for its confirmation email again, { \"test\": address } to send a confirmed address a test alert, or { \"remove\": address, \"confirm\": the same address }.", params: { trooth_id: ID, body: BODY }, required: ["body"], hints: SET_OPEN },
  { name: "semanto_signing_policy", title: "Two-officer signing (the person)", category: "Company", access: "person", page: `${DASH}/company`, description: "Whether two people must approve each version. A person's decision; answers the page where they set it.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_erase", title: "Erase Semanto (the person)", category: "Company", access: "person", page: `${DASH}/company`, description: "Erasing revokes every version and key and deletes everything. Only the owner can, by typing the domain. Answers the page.", params: { trooth_id: ID }, hints: READ },
  { name: "semanto_agent_keys", title: "Agent keys (the person)", category: "Company", access: "person", page: `${DASH}/company`, description: "Agent keys are made and revoked by a person. Answers the page.", params: { trooth_id: ID }, hints: READ },

  // ---------------------------------------------------------------- read and check any company (no key)
  { name: "semanto_read", title: "Read a company's signed copy", category: "Read and check", access: "public", method: "GET", path: pub("/{trooth_id}"), description: "A company's current Semanto file: every page's hash, the signature and the witness statement.", params: { trooth_id: { ...ID, description: "The company's Trooth ID." } }, required: ["trooth_id"], hints: READ },
  { name: "semanto_page", title: "Read one signed page", category: "Read and check", access: "public", method: "GET", path: pub("/{trooth_id}/by-path{path}"), description: "One page of a company's signed copy as markdown, by its path on the company's site.", params: { trooth_id: { ...ID, description: "The company's Trooth ID." }, path: { type: "string", description: "The page's path, for example /pricing." } }, required: ["trooth_id", "path"], hints: READ },
  { name: "semanto_facts", title: "A company's signed facts", category: "Read and check", access: "public", method: "GET", path: pub("/{trooth_id}/facts.jsonld"), description: "The company's signed facts as JSON-LD.", params: { trooth_id: { ...ID, description: "The company's Trooth ID." } }, required: ["trooth_id"], hints: READ },
  { name: "semanto_keys_public", title: "A company's public keys", category: "Read and check", access: "public", method: "GET", path: pub("/{trooth_id}/keys.json"), description: "The company's public signing keys (a JWK Set).", params: { trooth_id: { ...ID, description: "The company's Trooth ID." } }, required: ["trooth_id"], hints: READ },
  { name: "semanto_revocations", title: "Revoked versions and keys", category: "Read and check", access: "public", method: "GET", path: pub("/{trooth_id}/revocations"), description: "The company's signed revocation list.", params: { trooth_id: { ...ID, description: "The company's Trooth ID." } }, required: ["trooth_id"], hints: READ },
  { name: "semanto_verify", title: "Check a signed URL", category: "Read and check", access: "public", method: "GET", path: pub("/verify"), description: "Checks a page or file against its signature, its keys and the log, and answers each check in plain words.", params: { url: { type: "string", description: "The address to check." } }, required: ["url"], hints: READ_OPEN },
  { name: "semanto_log_checkpoint", title: "The public log's checkpoint", category: "Read and check", access: "public", method: "GET", path: pub("/log/checkpoint"), description: "The transparency log's current signed checkpoint (C2SP format).", params: {}, hints: READ },
  { name: "semanto_log_proof", title: "A log inclusion proof", category: "Read and check", access: "public", method: "GET", path: pub("/log/proof"), description: "An inclusion proof for a leaf in the public log.", params: { index: { type: "integer", description: "The leaf index." }, size: { type: "integer", description: "The tree size to prove against." } }, required: ["index"], hints: READ },
];

export const toolByName = (name: string): SemantoTool | undefined => SEMANTO_TOOLS.find((t) => t.name === name);
