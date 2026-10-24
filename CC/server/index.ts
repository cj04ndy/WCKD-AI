import express from "express";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const app = express();
const PORT = 17888;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CC_ROOT = path.resolve(__dirname, "..");
const WCKD_HOME = process.env.WCKD_HOME?.trim() || path.resolve(CC_ROOT, "..");
const WCKD_ROOT = path.join(WCKD_HOME, "CORE");
const WCKD_SHELL = path.join(WCKD_ROOT, "wckd-shell.ps1");
const DOCTOR = path.join(WCKD_ROOT, "wckd-doctor.ps1");
const RECOVERY = path.join(WCKD_ROOT, "wckd-recovery.ps1");
const LOGS_ROOT = path.join(WCKD_ROOT, "logs");
const CONTROL_CENTER_CHAT_LOG = path.join(LOGS_ROOT, "control-center-chat.jsonl");
const CORE_HEALTH_DEGRADED_LOG = path.join(CC_ROOT, "logs", "core-health-degraded.jsonl");
const ROUTER_BASE = "http://127.0.0.1:8002";
const ORCHESTRATOR_BASE = "http://127.0.0.1:8060";
const TOOLS_BASE = "http://127.0.0.1:8001";

type ServiceDefinition = {
  key: string;
  label: string;
  port: number;
  target: string;
  url?: string;
  kind?: "json" | "web";
  logName: string;
  optional?: boolean;
};

type ProbeDiagnostic = {
  url: string;
  elapsedMs: number;
  httpStatus: number | null;
  timedOut: boolean;
  reason: string;
  error: string;
  finalState: "online" | "degraded" | "offline" | "error";
};

const SERVICES: ServiceDefinition[] = [
  { key: "ollama", label: "Ollama", port: 11434, target: "ollama", url: "http://127.0.0.1:11434/api/version", kind: "json", logName: "ollama" },
  { key: "tools", label: "WCKD Tools", port: 8001, target: "tools", url: "http://127.0.0.1:8001/health", kind: "json", logName: "tools" },
  { key: "router", label: "Auto Router", port: 8002, target: "router", url: "http://127.0.0.1:8002/health", kind: "json", logName: "router" },
  { key: "lab", label: "WCKD Lab", port: 8020, target: "lab", url: "http://127.0.0.1:8020/health", kind: "json", logName: "lab-agent" },
  { key: "agent", label: "Agent Runner", port: 8030, target: "agent", url: "http://127.0.0.1:8030/health", kind: "json", logName: "agent-runner" },
  { key: "manager", label: "Model Manager", port: 8040, target: "manager", url: "http://127.0.0.1:8040/health", kind: "json", logName: "model-manager" },
  { key: "registry", label: "Specialist Registry", port: 8050, target: "registry", url: "http://127.0.0.1:8050/health", kind: "json", logName: "specialist-registry" },
  { key: "orchestrator", label: "Agent Orchestrator", port: 8060, target: "orchestrator", url: "http://127.0.0.1:8060/health", kind: "json", logName: "orchestrator" },
  { key: "memory", label: "Project Memory", port: 8070, target: "memory", url: "http://127.0.0.1:8070/health", kind: "json", logName: "memory" },
  { key: "webui", label: "Open WebUI", port: 8080, target: "webui", url: "http://127.0.0.1:8080/", kind: "web", logName: "webui", optional: true },
];

const VALID_RECOVERY_TARGETS = new Set([
  "all", "ollama", "tools", "lab", "manager", "registry",
  "router", "agent", "memory", "orchestrator", "webui",
]);
const CORE_RECOVERY_TARGETS = [
  "ollama", "tools", "lab", "manager", "registry",
  "router", "agent", "memory", "orchestrator",
] as const;

app.use(express.json({ limit: "10mb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function fetchJson(url: string, timeout = 1000): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchOk(url: string, timeout = 1000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch {
    return false;
  }
}

function normalizeStatus(raw: unknown): "online" | "degraded" | "offline" | "error" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (["ok", "online", "healthy", "ready", "idle", "running"].includes(s)) return "online";
  if (["degraded", "warning", "warn"].includes(s)) return "degraded";
  if (["error", "failed", "failure"].includes(s)) return "error";
  return "offline";
}

function serviceDetail(key: string, data: any): string {
  if (!data || typeof data !== "object") return "";

  if (key === "router") {
    const model = data.active_model ?? data.model ?? data.preferred_model;
    const task = data.task ?? data.route ?? data.mode;
    return [task, model].filter(Boolean).join(" · ");
  }

  if (key === "agent") {
    const jobs = data.running_jobs;
    return jobs !== undefined ? `${jobs} running job${Number(jobs) === 1 ? "" : "s"}` : "";
  }

  if (key === "manager") {
    return String(data.policy ?? "single-active-model");
  }

  if (key === "registry") {
    const count = data.specialists ?? data.count;
    return Number.isFinite(Number(count)) ? `${count} specialists` : "";
  }

  if (key === "orchestrator") {
    const queued = data.queued ?? 0;
    return data.active_job_id ? `active · ${queued} queued` : `${queued} queued`;
  }

  if (key === "memory") {
    return [data.retrieval, data.backend].filter(Boolean).join(" · ");
  }

  return "";
}

async function probeService(def: ServiceDefinition) {
  if (def.kind === "web") {
    const online = await fetchOk(def.url!, 2500);
    return {
      key: def.key,
      label: def.label,
      port: def.port,
      target: def.target,
      online,
      status: online ? "online" : "offline",
      version: "",
      detail: "",
      optional: Boolean(def.optional),
      diagnostic: {
        url: def.url!,
        elapsedMs: 0,
        httpStatus: null,
        timedOut: false,
        reason: online ? "ok" : "probe_failed",
        error: "",
        finalState: online ? "online" : "offline",
      } satisfies ProbeDiagnostic,
    };
  }

  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let data: any | null = null;
  let reason = "ok";
  let error = "";
  let timedOut = false;

  try {
    const response = await fetch(def.url!, { signal: AbortSignal.timeout(2500) });
    httpStatus = response.status;
    if (!response.ok) {
      reason = "non_2xx";
    } else {
      try {
        data = await response.json();
        if (!data || typeof data !== "object") reason = "invalid_or_unusable_json";
      } catch (err: any) {
        reason = "invalid_json";
        error = String(err?.message || err || "Invalid JSON");
      }
    }
  } catch (err: any) {
    timedOut = String(err?.name || "") === "TimeoutError" || /timeout/i.test(String(err?.message || ""));
    reason = timedOut ? "timeout" : "request_error";
    error = String(err?.message || err || "Request failed");
  }

  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const diagnostic = (finalState: ProbeDiagnostic["finalState"]): ProbeDiagnostic => ({
    url: def.url!,
    elapsedMs,
    httpStatus,
    timedOut,
    reason,
    error,
    finalState,
  });

  if (!data) {
    return {
      key: def.key,
      label: def.label,
      port: def.port,
      target: def.target,
      online: false,
      status: "offline",
      version: "",
      detail: "",
      optional: Boolean(def.optional),
      diagnostic: diagnostic("offline"),
    };
  }

  if (def.key === "ollama") {
    return {
      key: def.key,
      label: def.label,
      port: def.port,
      target: def.target,
      online: true,
      status: "online",
      version: String(data.version ?? ""),
      detail: "local LLM runtime",
      diagnostic: diagnostic("online"),
    };
  }

  const status = normalizeStatus(data.status ?? "ok");
  if (status === "degraded") reason = "service_degraded_status";
  else if (status === "error") reason = "service_error_status";
  else if (status === "offline") reason = "unrecognized_status";
  return {
    key: def.key,
    label: def.label,
    port: def.port,
    target: def.target,
    online: status === "online" || status === "degraded",
    status,
    version: String(data.version ?? ""),
    detail: serviceDetail(def.key, data),
    optional: Boolean(def.optional),
    diagnostic: diagnostic(status),
  };
}

async function gpuInfo() {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true, timeout: 3000 }
    );

    const first = stdout.split(/\r?\n/).find(Boolean);
    if (!first) return null;
    const [name, used, total, utilization, temperature] = first.split(",").map(v => v.trim());

    return {
      name,
      memoryUsedMB: Number(used),
      memoryTotalMB: Number(total),
      utilization: Number(utilization),
      temperature: Number(temperature),
    };
  } catch {
    return null;
  }
}

async function appendCoreHealthDegradedEvent(
  coreServices: Array<any>,
  overall: string,
  onlineCount: number,
  totalCount: number,
  logPath = CORE_HEALTH_DEGRADED_LOG,
) {
  const failedServices = coreServices.filter(service => service.status !== "online");
  const event = {
    timestamp: new Date().toISOString(),
    event: "core_health_degraded",
    overall,
    online_count: onlineCount,
    total_count: totalCount,
    failed_service_count: failedServices.length,
    diagnostics: failedServices.map(service => ({
      service: service.label,
      key: service.key,
      url: service.diagnostic.url,
      elapsed_ms: service.diagnostic.elapsedMs,
      http_status: service.diagnostic.httpStatus,
      timeout: service.diagnostic.timedOut,
      reason: service.diagnostic.reason,
      error: service.diagnostic.error || null,
      final_state: service.diagnostic.finalState,
    })),
  };

  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  } catch (err: any) {
    const reason = String(err?.message || err || "Unknown log write failure").replace(/[\r\n|]/g, " ");
    console.warn(`CORE_HEALTH_LOG_WRITE_FAILED path=${logPath} reason=${reason}`);
  }
}

async function stackState() {
  const services = await Promise.all(SERVICES.map(probeService));
  const coreServices = services.filter(service => !service.optional);
  const optionalServices = services.filter(service => service.optional);

  const onlineCount = coreServices.filter(service => service.online).length;
  const allOnline = coreServices.every(service => service.status === "online");
  const optionalOnlineCount = optionalServices.filter(service => service.online).length;

  const overall =
    allOnline ? "online" :
    onlineCount === 0 ? "offline" :
    "degraded";

  if (!allOnline) {
    const affected = coreServices
      .filter(service => service.status !== "online")
      .map(service => {
        const probe = service.diagnostic;
        const httpStatus = probe.httpStatus === null ? "na" : String(probe.httpStatus);
        const error = probe.error ? ` error=${probe.error.replace(/[\r\n|]/g, " ")}` : "";
        return `${service.label} url=${probe.url} elapsed_ms=${probe.elapsedMs} http_status=${httpStatus} timeout=${probe.timedOut} reason=${probe.reason} final_state=${probe.finalState}${error}`;
      })
      .join(" | ");
    await appendCoreHealthDegradedEvent(coreServices, overall, onlineCount, coreServices.length);
    console.warn(`CORE_HEALTH_DEGRADED timestamp=${new Date().toISOString()} ${affected}`);
  }

  const [managerStatus, registryRaw, orchestratorHealth, memoryHealth, gpu] = await Promise.all([
    fetchJson("http://127.0.0.1:8040/status", 900),
    fetchJson("http://127.0.0.1:8050/specialists", 900),
    fetchJson("http://127.0.0.1:8060/health", 900),
    fetchJson("http://127.0.0.1:8070/health", 900),
    gpuInfo(),
  ]);

  let specialistCount: number | undefined;
  let registryValid: boolean | undefined;

  if (Array.isArray(registryRaw)) {
    specialistCount = registryRaw.length;
  } else if (registryRaw && typeof registryRaw === "object") {
    if (Array.isArray(registryRaw.specialists)) specialistCount = registryRaw.specialists.length;
    else if (Number.isFinite(Number(registryRaw.count))) specialistCount = Number(registryRaw.count);
    registryValid = registryRaw.valid;
  }

  if (specialistCount === undefined) {
    const registryHealth = await fetchJson("http://127.0.0.1:8050/health", 900);
    if (registryHealth) {
      const n = registryHealth.specialists ?? registryHealth.count;
      if (Number.isFinite(Number(n))) specialistCount = Number(n);
      registryValid = registryHealth.valid ?? registryValid;
    }
  }

  return {
    version: "0.9.6",
    overall,
    onlineCount,
    total: coreServices.length,
    optionalOnlineCount,
    optionalTotal: optionalServices.length,
    services: services.map(({ diagnostic: _diagnostic, ...service }) => service),
    managerStatus,
    registry: {
      count: specialistCount,
      valid: registryValid,
    },
    orchestrator: orchestratorHealth ? {
      activeJobId: orchestratorHealth.active_job_id ?? null,
      queued: Number(orchestratorHealth.queued ?? 0),
      running: Number(orchestratorHealth.running ?? 0),
    } : null,
    memory: memoryHealth ? {
      projects: Number(memoryHealth.projects ?? 0),
      memories: Number(memoryHealth.memories ?? 0),
      retrieval: String(memoryHealth.retrieval ?? ""),
      databaseOk: Boolean(memoryHealth.database_ok),
    } : null,
    gpu,
  };
}

async function ollamaOnline() {
  return await fetchOk("http://127.0.0.1:11434/api/tags", 900);
}

function spawnPowerShell(command: string) {
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      cwd: WCKD_ROOT,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }
  );
  child.unref();
}

async function runPowerShellFile(file: string, args: string[] = [], timeout = 180000) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      {
        cwd: WCKD_ROOT,
        windowsHide: true,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return {
      ok: true,
      output: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err: any) {
    return {
      ok: false,
      output: String(err?.stdout ?? "").trim(),
      stderr: String(err?.stderr ?? err?.message ?? "PowerShell command failed").trim(),
    };
  }
}


async function runPowerShellCommand(command: string, timeout = 60000) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        cwd: WCKD_ROOT,
        windowsHide: true,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return {
      ok: true,
      output: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err: any) {
    return {
      ok: false,
      output: String(err?.stdout ?? "").trim(),
      stderr: String(err?.stderr ?? err?.message ?? "PowerShell command failed").trim(),
    };
  }
}

function serviceByTarget(target: string) {
  return SERVICES.find(service => service.target === target);
}

async function stopService(def: ServiceDefinition) {
  const command = [
    `$conn = Get-NetTCPConnection -LocalPort ${def.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if (-not $conn) { Write-Output '${def.label} is already stopped.'; exit 0 }`,
    "$ownerPid = [int]$conn.OwningProcess",
    "$proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue",
    "Stop-Process -Id $ownerPid -Force -ErrorAction Stop",
    "Start-Sleep -Milliseconds 350",
    `Write-Output ('Stopped ${def.label} on port ${def.port}; PID=' + $ownerPid + '; process=' + $(if ($proc) { $proc.ProcessName } else { 'unknown' }))`,
  ].join("; ");

  return await runPowerShellCommand(command, 30000);
}

async function tailServiceLog(def: ServiceDefinition, requestedLines: number) {
  const lines = Math.max(20, Math.min(400, requestedLines || 140));
  const candidates = [
    path.join(LOGS_ROOT, `${def.logName}.log`),
    path.join(LOGS_ROOT, `${def.logName}-error.log`),
  ];

  const files: string[] = [];
  const chunks: string[] = [];

  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      files.push(file);

      const tail = raw
        .split(/\r?\n/)
        .slice(-lines)
        .join("\n")
        .trimEnd();

      chunks.push(
        `===== ${path.basename(file)} =====\n${tail || "(empty log)"}`
      );
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        chunks.push(
          `===== ${path.basename(file)} =====\nERROR reading log: ${String(err?.message ?? err)}`
        );
      }
    }
  }

  if (chunks.length === 0) {
    chunks.push(`No dedicated log files found yet for ${def.label}.`);
  }

  return {
    ok: true,
    target: def.target,
    label: def.label,
    lines,
    files,
    output: chunks.join("\n\n"),
  };
}

type ConsoleEvent = {
  id: string;
  ts: string;
  source: string;
  level: "info" | "warn" | "error" | "success";
  kind: "work" | "error" | "raw";
  event: string;
  text: string;
  data?: Record<string, any>;
};

async function appendChatAudit(event: Record<string, any>) {
  try {
    await mkdir(LOGS_ROOT, { recursive: true });
    await appendFile(
      CONTROL_CENTER_CHAT_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...event,
      }) + "\n",
      "utf8"
    );
  } catch {
    // Chat must keep working even if audit logging cannot be written.
  }
}

function openAiMessagesFromWckd(messages: any[]) {
  return (Array.isArray(messages) ? messages : []).map((message: any) => {
    const role = String(message?.role || "user");
    const text = String(message?.content || "");
    const images = Array.isArray(message?.images) ? message.images : [];

    if (!images.length) {
      return { role, content: text };
    }

    const content: any[] = [];
    if (text) content.push({ type: "text", text });


    return { role, content };
  });
}

function latestUserText(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;

    if (typeof message?.content === "string") {
      return message.content.trim();
    }

    if (Array.isArray(message?.content)) {
      return message.content
        .filter((item: any) => item?.type === "text" && typeof item?.text === "string")
        .map((item: any) => item.text)
        .join("\n")
        .trim();
    }
  }

  return "";
}

function compactExecutionEvidenceEvent(event: any) {
  const text = (value: any, max = 800) => {
    if (value === null || value === undefined) return undefined;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  };

  return {
    event: text(event?.event, 80),
    step: Number.isFinite(Number(event?.step)) ? Number(event.step) : undefined,
    tool: text(event?.tool, 120),
    ok: typeof event?.ok === "boolean" ? event.ok : undefined,
    result: text(event?.result, 800),
    exit_code: Number.isFinite(Number(event?.exit_code)) ? Number(event.exit_code) : undefined,
    stdout: text(event?.stdout, 800),
    stderr: text(event?.stderr, 800),
    message: text(event?.message, 800),
  };
}

async function executionMetadataFromOrchestratorResult(result: any, jobId: string) {
  const stages = Array.isArray(result?.stage_results) ? result.stage_results : [];
  const executeStage = [...stages]
    .reverse()
    .find((stage: any) => stage?.type === "agent" || stage?.runner_job_id);

  const verification = result?.verification && typeof result.verification === "object"
    ? result.verification
    : {};

  const gatePassed =
    verification?.verification_gate_passed === true ||
    executeStage?.verification_gate_passed === true;

  const successSeen =
    verification?.verification_success_seen === true ||
    executeStage?.verification_success_seen === true;

  const failureSeen =
    verification?.verification_failure_seen === true ||
    executeStage?.verification_failure_seen === true;

  const runnerJobId = String(
    verification?.runner_job_id ||
    executeStage?.runner_job_id ||
    ""
  ) || undefined;

  let rawEvents = Array.isArray(executeStage?.evidence_events)
    ? executeStage.evidence_events
    : Array.isArray(verification?.evidence_events)
      ? verification.evidence_events
      : [];

  if (runnerJobId) {
    const runnerLog = await fetchJson(
      `http://127.0.0.1:8030/agent/log/${encodeURIComponent(runnerJobId)}?tail=200`,
      3500
    );

    if (Array.isArray(runnerLog?.events) && runnerLog.events.length) {
      rawEvents = runnerLog.events;
    }
  }

  const relevantEvents = rawEvents.filter((event: any) =>
    event?.ok === false ||
    ["tool_call", "tool_result", "verification_tool_turn", "job_completed"].includes(
      String(event?.event || "")
    )
  );

  const compactEvents = relevantEvents.map(compactExecutionEvidenceEvent);
  const failedEvents = compactEvents.filter((event: any) => event?.ok === false);
  const recentEvents = compactEvents.slice(-10);
  const evidenceEvents: any[] = [];
  const evidenceSeen = new Set<string>();

  for (const event of [...failedEvents, ...recentEvents]) {
    const signature = JSON.stringify(event);
    if (evidenceSeen.has(signature)) continue;
    evidenceSeen.add(signature);
    evidenceEvents.push(event);
  }

  const successfulToolResults = Number(
    verification?.successful_tool_results ??
    executeStage?.successful_tool_results ??
    0
  );

  const failedToolResults = Number(
    verification?.failed_tool_results ??
    executeStage?.failed_tool_results ??
    0
  );

  const rawPacket = String(executeStage?.evidence_packet || "");
  const evidencePacket = rawPacket.length > 12000
    ? `${rawPacket.slice(0, 12000)}\n...[truncated by WCKD Control Center]`
    : rawPacket;

  return {
    verified: gatePassed && successSeen && !failureSeen,
    recovered: gatePassed && successSeen && !failureSeen && failedToolResults > 0,
    orchestratorJobId: jobId,
    runnerJobId,

    workspace: String(result?.workspace || "") || undefined,
    verificationGatePassed: gatePassed,
    verificationSuccessSeen: successSeen,
    verificationFailureSeen: failureSeen,
    successfulToolResults: Number.isFinite(successfulToolResults) ? successfulToolResults : 0,
    failedToolResults: Number.isFinite(failedToolResults) ? failedToolResults : 0,
    evidenceSource: String(
      verification?.evidence_source ||
      executeStage?.evidence_source ||
      ""
    ) || undefined,
    evidencePacket: evidencePacket || undefined,
    evidenceEvents,
  };
}
function hasExecutionIntent(prompt: string) {
  const text = String(prompt || "").toLowerCase();

  const patterns = [
    /\b(create|modify|edit|change|fix|repair|implement|install|configure|build|compile|run|execute|test|retest|deploy|start|stop|restart|delete|remove|move|copy|rename|save|write)\b/,
    /\b(creeaza|creează|modifica|modifică|editeaza|editează|schimba|schimbă|repara|repară|implementeaza|implementează|instaleaza|instalează|configureaza|configurează|construieste|construiește|compileaza|compilează|ruleaza|rulează|executa|execută|testeaza|testează|retesteaza|retestează|porneste|pornește|opreste|oprește|reporneste|repornește|sterge|șterge|muta|mută|copiaza|copiază|redenumește|salveaza|salvează|scrie)\b/,
    /\b(fa-mi|fă-mi|fa asta|fă asta|continua dezvoltarea|continuă dezvoltarea|pune in proiect|pune în proiect)\b/,
  ];

  return patterns.some(pattern => pattern.test(text));
}

function wantsExplanationOnly(prompt: string) {
  const text = String(prompt || "").trim().toLowerCase();

  return (
    /\?$/.test(text) ||
    /^(ce|care|cine|de ce|cum|cand|când|unde|what|which|who|why|how|when|where|explain|explica|explică|descrie|describe|summarize|rezuma|rezumă)\b/.test(text)
  );
}

async function postJson(url: string, body: any, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: any = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(
        typeof data?.detail === "string"
          ? data.detail
          : typeof data?.error === "string"
            ? data.error
            : `${response.status} ${response.statusText}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function webSearchIntent(prompt: string) {
  const text = String(prompt || "").trim().toLowerCase();

  const explicit = /\b(web search|search the web|search online|look it up online|cauta pe web|caută pe web|cauta pe net|caută pe net|cauta online|caută online|verifica online|verifică online|pe internet|on the internet)\b/.test(text);

  const fresh = /\b(latest|newest|current|currently|today|tonight|recent|recently|news|release|released|update|updated|version|price|pricing|availability|available|stock|weather|forecast|score|schedule|azi|astăzi|astazi|acum|recent|noutati|noutăți|stiri|știri|lansare|versiune|pret|preț|disponibil|disponibilitate|stoc|vreme|prognoza|prognoză|scor|program)\b/.test(text);

  const shortEntityLookup =
    text.length <= 90 &&
    /^(ce este|ce e|cine este|ce inseamna|ce înseamnă|what is|who is|what does)\b/.test(text);

  return {
    useWeb: explicit || fresh || shortEntityLookup,
    explicit,
    fresh,
    shortEntityLookup,
  };
}

function webSearchQuery(prompt: string, intent: ReturnType<typeof webSearchIntent>) {
  const raw = String(prompt || "").trim();
  if (!raw) return raw;

  if (intent.shortEntityLookup) {
    const match = raw.match(
      /^(?:ce este|ce e|cine este|ce inseamna|ce înseamnă|what is|who is|what does)\s+(.+?)[?.!]*$/i
    );

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return raw
    .replace(/^(?:te rog\s+)?(?:cauta|caută|verifica|verifică|search|look up)\s+(?:pe\s+web|pe\s+net|online|the\s+web)?\s*/i, "")
    .trim();
}

function webSearchContext(search: any) {
  const results = Array.isArray(search?.results) ? search.results : [];

  if (!results.length) return "";

  const lines = results.map((item: any, index: number) => {
    const title = String(item?.title || "Untitled").replace(/\s+/g, " ").trim();
    const url = String(item?.url || "").trim();
    const snippet = String(item?.snippet || "").replace(/\s+/g, " ").trim();

    return `[${index + 1}] ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  });

  return [
    "WCKD WEB SEARCH RESULTS",
    `Query: ${String(search?.query || "")}`,
    `Provider: ${String(search?.provider || "web")}`,
    "",
    ...lines,
    "",
    "GROUNDING RULES:",
    "- Use the search results when they are relevant to the user's question.",
    "- Cite supported factual claims inline using [1], [2], etc.",
    "- Do not invent details that are not supported by the result snippets.",
    "- A Sources section will be appended by WCKD automatically.",
  ].join("\n");
}

function webSourcesFooter(search: any) {
  const results = Array.isArray(search?.results) ? search.results : [];

  if (!results.length) return "";

  return "\n\nSources:\n" + results.map((item: any, index: number) => {
    const title = String(item?.title || "Source").replace(/\s+/g, " ").trim();
    const url = String(item?.url || "").trim();
    return `[${index + 1}] ${title} — ${url}`;
  }).join("\n");
}

async function runWckdWebSearch(
  sessionId: string,
  query: string,
  limit = 5
) {
  await appendChatAudit({
    event: "web_search_started",
    session_id: sessionId,
    query,
    limit,
  });

  try {
    const result = await postJson(
      `${TOOLS_BASE}/web/search`,
      {
        query,
        limit,
      },
      20000
    );

    const count = Array.isArray(result?.results) ? result.results.length : 0;

    await appendChatAudit({
      event: "web_search_completed",
      session_id: sessionId,
      query,
      provider: result?.provider || null,
      count,
      domains: Array.isArray(result?.results)
        ? result.results.map((item: any) => {
            try {
              return new URL(String(item?.url || "")).hostname;
            } catch {
              return "";
            }
          }).filter(Boolean)
        : [],
    });

    return result;
  } catch (err: any) {
    await appendChatAudit({
      event: "web_search_failed",
      session_id: sessionId,
      query,
      error: err?.message || String(err),
    });

    return {
      status: "error",
      query,
      provider: null,
      results: [],
      error: err?.message || String(err),
    };
  }
}

async function readChatSessionEvents(sessionId: string, limit: number) {
  const events: ConsoleEvent[] = [];

  try {
    const raw = await readFile(CONTROL_CENTER_CHAT_LOG, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      if (String(item?.session_id ?? "") !== sessionId) continue;

      const eventName = String(item?.event ?? "chat_event");
      const source =
        eventName === "auto_route"
          ? "ROUTER"
          : eventName.startsWith("web_search")
            ? "TOOL"
            : eventName.startsWith("auto_orchestrator")
              ? "ORCH"
              : eventName === "chat_first_token" || eventName === "chat_completed"
                ? "MODEL"
                : "CHAT";

      const level: ConsoleEvent["level"] =
        eventName === "chat_failed" ? "error" :
        eventName === "chat_aborted" ? "warn" :
        eventName === "chat_completed" ? "success" :
        "info";

      events.push({
        id: consoleEventId(["CHAT-SESSION", sessionId, item]),
        ts: consoleTimestamp(item?.ts),
        source,
        level,
        kind: eventName === "chat_failed" ? "error" : "work",
        event: eventName,
        text: auditEventText(item),
        data: compactConsoleData(item),
      });
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      events.push({
        id: consoleEventId(["CHAT-SESSION", sessionId, "read-error", String(err?.message ?? err)]),
        ts: new Date().toISOString(),
        source: "CHAT",
        level: "error",
        kind: "error",
        event: "activity_read_error",
        text: String(err?.message ?? err),
      });
    }
  }

  return events
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-limit);
}

function lastUserPreview(messages: any[]) {
  const reversed = [...messages].reverse();
  const item = reversed.find(message => message?.role === "user");
  const text = String(item?.content ?? "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function consoleEventId(parts: any[]) {
  return createHash("sha1")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 18);
}

function consoleTimestamp(value: any, fallback?: string) {
  const raw = String(value ?? "").trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback || new Date().toISOString();
}

function compactConsoleData(value: any) {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, any> = {};

  for (const [key, item] of Object.entries(value)) {
    if (["ts","event","job_id","status"].includes(key)) continue;
    if (item === null || item === undefined) continue;

    if (typeof item === "string") {
      result[key] = item.length > 300 ? `${item.slice(0, 300)}…` : item;
    } else if (typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
    }
  }

  return result;
}

function auditEventText(event: any) {
  const name = String(event?.event ?? "event");
  const tool = String(event?.tool ?? event?.tool_name ?? event?.name ?? "").trim();
  const model = String(event?.model ?? event?.last_model ?? "").trim();
  const step = event?.step ?? event?.model_step ?? event?.turn;
  const ok = event?.ok;

  if (name === "web_search_started") {
    return `web_search · query="${event?.query || ""}"`;
  }
  if (name === "web_search_completed") {
    return `web_search · ${event?.provider || "web"} · ${event?.count ?? 0} results${Array.isArray(event?.domains) && event.domains.length ? ` · ${event.domains.slice(0, 4).join(", ")}` : ""}`;
  }
  if (name === "web_search_failed") {
    return `web_search · failed · ${event?.error || "unknown error"}`;
  }
  if (name === "auto_route") {
    return `${event?.mode || "direct"} · ${event?.task || "GENERAL"} → ${event?.model || "?"} · ${event?.reason || ""}`;
  }
  if (name === "auto_orchestrator_started") {
    return `${event?.job_id || "job"} · ${event?.project_id ? `memory=${event.project_id}` : "no project memory"}`;
  }
  if (name === "auto_orchestrator_stage") {
    return `${event?.job_id || "job"} · ${event?.stage || "stage"} · ${event?.progress || ""}`.trim();
  }
  if (name === "auto_orchestrator_completed") {
    const verification = event?.verified === true
      ? (
          event?.recovered === true
            ? ` · VERIFIED WITH RECOVERY · ${event?.successful_tool_results ?? 0} tools OK / ${event?.failed_tool_results ?? 0} recovered`
            : ` · VERIFIED · ${event?.successful_tool_results ?? 0} tools OK / 0 failed`
        )
      : "";
    return `${event?.job_id || "job"} · completed${verification}${event?.saved_memory ? ` · saved=${event.saved_memory}` : ""}`;
  }
  if (name === "auto_orchestrator_failed") {
    return `${event?.job_id || "job"} · ${event?.error || "failed"}`;
  }
  if (name === "chat_started") {
    const mode = "TEXT";
    return `${event?.model || "model"} · ${mode}${event?.prompt ? ` · ${event.prompt}` : ""}`;
  }
  if (name === "chat_first_token") {
    return `${event?.model || "model"} · first token${event?.first_token_ms != null ? ` · ${event.first_token_ms} ms` : ""}`;
  }
  if (name === "chat_completed") {
    const parts = [
      event?.model || "model",
      "TEXT",
      event?.output_tokens != null ? `${event.output_tokens} out` : "",
      event?.prompt_tokens != null ? `${event.prompt_tokens} prompt` : "",
      event?.generation_tps != null ? `${Number(event.generation_tps).toFixed(1)} tok/s` : "",
      event?.total_seconds != null ? `${Number(event.total_seconds).toFixed(1)}s` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  if (name === "chat_failed") {
    return `${event?.model || "model"} · ${event?.error || "chat failed"}`;
  }
  if (name === "chat_aborted") {
    return `${event?.model || "model"} · client aborted`;
  }
  if (name === "model_call") return `${step != null ? `step ${step} · ` : ""}model call`;
  if (name === "model_response") return `${model || "model"}${step != null ? ` · step ${step}` : ""}`;
  if (name === "tool_call") return `${tool || "tool"}${step != null ? ` · step ${step}` : ""}`;
  if (name === "tool_result") return `${tool || "tool"} · ${ok === false ? "FAILED" : "result"}`;
  if (name === "verification_tool_turn") return `verification · ${ok === false ? "FAILED" : "OK"}`;
  if (name === "job_started") return "job started";
  if (name === "job_completed") return "job completed";
  if (name === "job_failed") return String(event?.error ?? "job failed");
  if (name === "stage_started") return `${event?.stage_id ?? "stage"} · ${event?.specialist ?? ""}`.trim();
  if (name === "stage_completed") return `${event?.stage_id ?? "stage"} · ${model || event?.specialist || ""}`.trim();
  if (name === "runner_started") return `${event?.stage_id ?? "agent"} · ${event?.runner_job_id ?? ""}`.trim();

  const data = compactConsoleData(event);
  const summary = Object.entries(data)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");

  return summary || name;
}

async function parseJsonLines(file: string, source: string, kind: "work" | "error" | "raw", limit: number) {
  const events: ConsoleEvent[] = [];

  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        const eventName = String(item?.event ?? "event");
        const ts = consoleTimestamp(item?.ts);
        const level: ConsoleEvent["level"] =
          /fail|error|blocked|timeout|stall/i.test(eventName) ? "error" :
          /completed|success|verified/i.test(eventName) ? "success" :
          "info";

        events.push({
          id: consoleEventId([source, item]),
          ts,
          source,
          level,
          kind,
          event: eventName,
          text: auditEventText(item),
          data: compactConsoleData(item),
        });
      } catch {
        // Ignore malformed/incomplete append-only lines.
      }
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      events.push({
        id: consoleEventId([source, "read-error", String(err?.message ?? err)]),
        ts: new Date().toISOString(),
        source,
        level: "error",
        kind: "error",
        event: "log_read_error",
        text: String(err?.message ?? err),
      });
    }
  }

  return events;
}

async function tailTextLog(file: string, source: string, kind: "error" | "raw", limit: number) {
  const events: ConsoleEvent[] = [];

  try {
    const raw = await readFile(file, "utf8");
    const all = raw.split(/\r?\n/);
    const start = Math.max(0, all.length - limit);

    for (let index = start; index < all.length; index++) {
      const line = all[index]?.trim();
      if (!line) continue;

      events.push({
        id: consoleEventId([file, index, line]),
        ts: new Date(0).toISOString(),
        source,
        level: kind === "error" ? "error" : "info",
        kind,
        event: kind === "error" ? "stderr" : "log",
        text: line.length > 500 ? `${line.slice(0, 500)}…` : line,
      });
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      events.push({
        id: consoleEventId([file, "read-error", String(err?.message ?? err)]),
        ts: new Date().toISOString(),
        source,
        level: "error",
        kind: "error",
        event: "log_read_error",
        text: String(err?.message ?? err),
      });
    }
  }

  return events;
}

async function proxyJsonRequest(
  url: string,
  method: string = "GET",
  body?: any,
  timeout = 30000
) {
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });

    const raw = await response.text();
    let data: any = {};

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { output: raw };
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      data: { error: err?.message || "Upstream request failed." },
    };
  }
}

app.get("/api/chat/activity/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const limit = Math.max(50, Math.min(2000, Number(req.query.limit ?? 2000) || 2000));

  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ error: "invalid chat session id" });
  }

  const events = await readChatSessionEvents(sessionId, limit);

  res.json({
    status: "ok",
    version: "0.9.6",
    session_id: sessionId,
    events,
    count: events.length,
    order: "oldest-to-latest",
  });
});

app.get("/api/live-console", async (req, res) => {
  const limit = Math.max(40, Math.min(400, Number(req.query.limit ?? 240) || 240));
  const events: ConsoleEvent[] = [];

  let activeJobId: string | null = null;
  let selectedJobId: string | null = null;
  let orchStatus: any = null;
  let runnerStatus: any = null;
  let runnerJobId: string | null = null;

  const orchHealth = await fetchJson("http://127.0.0.1:8060/health", 2500);
  activeJobId = orchHealth?.active_job_id ? String(orchHealth.active_job_id) : null;

  if (activeJobId) {
    selectedJobId = activeJobId;
  } else {
    const recent = await fetchJson("http://127.0.0.1:8060/orchestrator/list?limit=1", 2500);
    selectedJobId = recent?.jobs?.[0]?.job_id ? String(recent.jobs[0].job_id) : null;
  }

  if (selectedJobId) {
    orchStatus = await fetchJson(
      `http://127.0.0.1:8060/orchestrator/status/${encodeURIComponent(selectedJobId)}`,
      2500
    );

    runnerJobId = orchStatus?.active_runner_job_id
      ? String(orchStatus.active_runner_job_id)
      : null;

    if (!runnerJobId) {
      const result = await fetchJson(
        `http://127.0.0.1:8060/orchestrator/result/${encodeURIComponent(selectedJobId)}`,
        2500
      );
      const stages = Array.isArray(result?.stage_results) ? result.stage_results : [];
      const runnerStage = [...stages].reverse().find((stage: any) => stage?.runner_job_id);
      runnerJobId = runnerStage?.runner_job_id ? String(runnerStage.runner_job_id) : null;
    }

    events.push(...await parseJsonLines(
      path.join(WCKD_ROOT, "orchestrator", "logs", `${selectedJobId}.jsonl`),
      "ORCH",
      "work",
      Math.max(40, Math.floor(limit / 2))
    ));
  }

  if (runnerJobId) {
    runnerStatus = await fetchJson(
      `http://127.0.0.1:8030/agent/status/${encodeURIComponent(runnerJobId)}`,
      2500
    );

    const runnerLog = await fetchJson(
      `http://127.0.0.1:8030/agent/log/${encodeURIComponent(runnerJobId)}?tail=${Math.min(180, limit)}`,
      3000
    );

    for (const item of Array.isArray(runnerLog?.events) ? runnerLog.events : []) {
      const eventName = String(item?.event ?? "event");
      const ts = consoleTimestamp(item?.ts);
      const level: ConsoleEvent["level"] =
        /fail|error|blocked|timeout|stall/i.test(eventName) || item?.ok === false ? "error" :
        /completed|success|verification/i.test(eventName) && item?.ok !== false ? "success" :
        "info";

      events.push({
        id: consoleEventId(["AGENT", item]),
        ts,
        source:
          eventName.startsWith("tool_") || eventName === "verification_tool_turn"
            ? "TOOL"
            : eventName.startsWith("model_")
              ? "MODEL"
              : "AGENT",
        level,
        kind: "work",
        event: eventName,
        text: auditEventText(item),
        data: compactConsoleData(item),
      });
    }
  }

  events.push(...await parseJsonLines(
    CONTROL_CENTER_CHAT_LOG,
    "CHAT",
    "work",
    Math.max(60, Math.floor(limit / 2))
  ));

  const rawSources = [
    ["ROUTER", path.join(LOGS_ROOT, "router.log")],
    ["AGENT", path.join(LOGS_ROOT, "agent-runner.log")],
    ["ORCH", path.join(LOGS_ROOT, "orchestrator.log")],
    ["MEMORY", path.join(LOGS_ROOT, "memory.log")],
    ["MODEL", path.join(LOGS_ROOT, "model-manager.log")],
  ] as const;

  for (const [source, file] of rawSources) {
    events.push(...await tailTextLog(file, source, "raw", 10));
  }

  for (const service of SERVICES) {
    events.push(...await tailTextLog(
      path.join(LOGS_ROOT, `${service.logName}-error.log`),
      service.key.toUpperCase(),
      "error",
      8
    ));
  }

  // State-change style events. IDs are based on state, so polling does not spam
  // duplicate lines; a new line appears only when the state changes.
  if (orchStatus) {
    const progress = orchStatus?.progress;
    const text = [
      orchStatus?.status || "unknown",
      orchStatus?.current_stage ? `stage=${orchStatus.current_stage}` : "",
      progress ? `${progress.completed_stages ?? 0}/${progress.total_stages ?? 0}` : "",
      orchStatus?.memory_used ? `memory=${orchStatus.memory_citations ?? 0}` : "",
    ].filter(Boolean).join(" · ");

    events.push({
      id: consoleEventId(["ORCH-STATE", selectedJobId, text]),
      ts: consoleTimestamp(orchStatus?.updated),
      source: "ORCH",
      level: orchStatus?.status === "failed" ? "error" : orchStatus?.status === "completed" ? "success" : "info",
      kind: "work",
      event: "state",
      text,
    });
  }

  if (runnerStatus) {
    const text = [
      runnerStatus?.status || "unknown",
      runnerStatus?.step != null ? `step ${runnerStatus.step}/${runnerStatus.max_steps ?? "?"}` : "",
      runnerStatus?.last_activity || "",
      runnerStatus?.last_model || "",
      runnerStatus?.successful_tool_results != null ? `tools ok=${runnerStatus.successful_tool_results}` : "",
      runnerStatus?.failed_tool_results ? `failed=${runnerStatus.failed_tool_results}` : "",
    ].filter(Boolean).join(" · ");

    events.push({
      id: consoleEventId(["AGENT-STATE", runnerJobId, text]),
      ts: consoleTimestamp(runnerStatus?.updated ?? runnerStatus?.last_update),
      source: "AGENT",
      level: /failed|blocked|timeout|stalled/i.test(String(runnerStatus?.status)) ? "error" : runnerStatus?.status === "completed" ? "success" : "info",
      kind: "work",
      event: "state",
      text,
    });
  }

  const manager = await fetchJson("http://127.0.0.1:8040/status", 2500);
  const managerModel = manager?.active_model ?? manager?.state?.active_model ?? null;

  if (managerModel) {
    events.push({
      id: consoleEventId(["MODEL-STATE", managerModel]),
      ts: consoleTimestamp(manager?.state?.updated),
      source: "MODEL",
      level: "info",
      kind: "work",
      event: "resident",
      text: `${managerModel} resident in VRAM`,
    });
  }

  const dedup = new Map<string, ConsoleEvent>();
  for (const event of events) dedup.set(event.id, event);

  const sorted = [...dedup.values()]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-limit);

  const progress = orchStatus?.progress
    ? `${orchStatus.progress.completed_stages ?? 0}/${orchStatus.progress.total_stages ?? 0}`
    : null;

  res.json({
    status: "ok",
    version: "0.9.6",
    events: sorted,
    meta: {
      orchestrator: {
        job_id: selectedJobId,
        status: orchStatus?.status ?? null,
        stage: orchStatus?.current_stage ?? null,
        progress,
      },
      runner: {
        job_id: runnerJobId,
        status: runnerStatus?.status ?? null,
        step: runnerStatus?.step ?? null,
        max_steps: runnerStatus?.max_steps ?? null,
        activity: runnerStatus?.last_activity ?? null,
        model: runnerStatus?.last_model ?? null,
      },
      model: {
        active_model: manager?.active_model ?? null,
        state_model: manager?.state?.active_model ?? null,
      },
    },
  });
});

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "WCKD Core",
    version: "0.9.6",
    ollama: await ollamaOnline(),
  });
});

app.get("/api/stack", async (_req, res) => {
  try {
    res.json(await stackState());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Stack health failed" });
  }
});

app.post("/api/suite/start", async (_req, res) => {
  spawnPowerShell(`. '${WCKD_SHELL.replace(/'/g, "''")}'; start-wckd-suite`);
  res.json({ ok: true, output: "WCKD Suite start requested." });
});

app.post("/api/suite/stop", async (_req, res) => {
  spawnPowerShell(`. '${WCKD_SHELL.replace(/'/g, "''")}'; kill-wckd-suite`);
  res.json({ ok: true, output: "WCKD Suite stop requested." });
});

app.post("/api/service/:target/start", async (req, res) => {
  const target = String(req.params.target || "").toLowerCase();
  const def = serviceByTarget(target);
  if (!def || !VALID_RECOVERY_TARGETS.has(target)) {
    return res.status(400).json({ error: `Invalid service target: ${target}` });
  }

  const result = await runPowerShellFile(RECOVERY, ["-Target", target], 180000);
  res.status(result.ok ? 200 : 500).json({
    ...result,
    target,
    action: "start",
  });
});

app.post("/api/service/:target/stop", async (req, res) => {
  const target = String(req.params.target || "").toLowerCase();
  const def = serviceByTarget(target);
  if (!def || !VALID_RECOVERY_TARGETS.has(target)) {
    return res.status(400).json({ error: `Invalid service target: ${target}` });
  }

  const result = await stopService(def);
  res.status(result.ok ? 200 : 500).json({
    ...result,
    target,
    action: "stop",
  });
});

app.get("/api/service/:target/log", async (req, res) => {
  const target = String(req.params.target || "").toLowerCase();
  const def = serviceByTarget(target);
  if (!def || !VALID_RECOVERY_TARGETS.has(target)) {
    return res.status(400).json({ error: `Invalid service target: ${target}` });
  }

  const requested = Number(req.query.lines ?? 140);
  const result = await tailServiceLog(def, Number.isFinite(requested) ? requested : 140);
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/doctor", async (_req, res) => {
  const result = await runPowerShellFile(DOCTOR, [], 180000);
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/recovery", async (_req, res) => {
  const results: any[] = [];
  let ok = true;

  for (const target of CORE_RECOVERY_TARGETS) {
    const result = await runPowerShellFile(RECOVERY, ["-Target", target], 180000);
    results.push({ target, ...result });
    if (!result.ok) ok = false;
  }

  const output = results
    .map(item => `===== ${String(item.target).toUpperCase()} =====\n${String(item.output ?? "")}`)
    .join("\n\n");

  res.status(ok ? 200 : 500).json({
    ok,
    target: "core",
    results,
    output,
  });
});

app.post("/api/recovery/:target", async (req, res) => {
  const target = String(req.params.target || "").toLowerCase();
  if (!VALID_RECOVERY_TARGETS.has(target)) {
    return res.status(400).json({ error: `Invalid recovery target: ${target}` });
  }

  const result = await runPowerShellFile(RECOVERY, ["-Target", target], 180000);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get("/api/model-manager/status", async (_req, res) => {
  const data = await fetchJson("http://127.0.0.1:8040/status", 3000);
  if (!data) return res.status(503).json({ error: "Model Manager unavailable." });
  res.json(data);
});

app.post("/api/model-manager/load/:model", async (req, res) => {
  const model = String(req.params.model || "").trim();
  if (!model) return res.status(400).json({ error: "Model is required." });

  try {
    const upstream = await fetch(`http://127.0.0.1:8040/load/${encodeURIComponent(model)}`, {
      method: "POST",
      signal: AbortSignal.timeout(180000),
    });
    const body = await upstream.text();
    const data = body ? JSON.parse(body) : {};
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Model load failed." });
  }
});

app.post("/api/model-manager/switch/:model", async (req, res) => {
  const model = String(req.params.model || "").trim();
  if (!model) return res.status(400).json({ error: "Model is required." });

  try {
    const upstream = await fetch(`http://127.0.0.1:8040/switch/${encodeURIComponent(model)}`, {
      method: "POST",
      signal: AbortSignal.timeout(180000),
    });
    const body = await upstream.text();
    const data = body ? JSON.parse(body) : {};
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Model switch failed." });
  }
});

app.post("/api/model-manager/unload", async (_req, res) => {
  try {
    const upstream = await fetch("http://127.0.0.1:8040/unload", {
      method: "POST",
      signal: AbortSignal.timeout(120000),
    });
    const body = await upstream.text();
    const data = body ? JSON.parse(body) : {};
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Model unload failed." });
  }
});

app.get("/api/specialists", async (_req, res) => {
  const raw = await fetchJson("http://127.0.0.1:8050/specialists", 3000);
  if (!raw) return res.status(503).json({ specialists: [], error: "Specialist Registry unavailable." });

  const list =
    Array.isArray(raw) ? raw :
    Array.isArray(raw.specialists) ? raw.specialists :
    [];

  const specialists = list.map((item: any) => ({
    id: String(item.id ?? item.specialist_id ?? item.name ?? "").toUpperCase(),
    model: String(item.model ?? item.primary_model ?? item.preferred_model ?? "—"),
    fallback: Array.isArray(item.fallback)
      ? item.fallback
      : Array.isArray(item.fallback_models)
        ? item.fallback_models
        : [],
    route: String(item.route ?? item.route_mode ?? item.command ?? ""),
    tools: String(item.tools ?? item.tool_policy ?? ""),
    temperature: Number.isFinite(Number(item.temperature)) ? Number(item.temperature) : undefined,
    maxSteps: Number.isFinite(Number(item.max_steps)) ? Number(item.max_steps) : undefined,
  })).filter((item: any) => item.id);

  res.json({ specialists });
});

app.get("/api/orchestrator/workflows", async (_req, res) => {
  const result = await proxyJsonRequest("http://127.0.0.1:8060/orchestrator/workflows");
  res.status(result.status).json(result.data);
});

app.get("/api/orchestrator/jobs", async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 30) || 30));
  const result = await proxyJsonRequest(`http://127.0.0.1:8060/orchestrator/list?limit=${limit}`);
  res.status(result.status).json(result.data);
});

app.get("/api/orchestrator/status/:jobId", async (req, res) => {
  const jobId = encodeURIComponent(String(req.params.jobId || ""));
  const result = await proxyJsonRequest(`http://127.0.0.1:8060/orchestrator/status/${jobId}`);
  res.status(result.status).json(result.data);
});

app.get("/api/orchestrator/result/:jobId", async (req, res) => {
  const jobId = encodeURIComponent(String(req.params.jobId || ""));
  const result = await proxyJsonRequest(`http://127.0.0.1:8060/orchestrator/result/${jobId}`);
  res.status(result.status).json(result.data);
});

app.post("/api/orchestrator/preview", async (req, res) => {
  const result = await proxyJsonRequest(
    "http://127.0.0.1:8060/orchestrator/preview",
    "POST",
    req.body ?? {},
    30000
  );
  res.status(result.status).json(result.data);
});

app.post("/api/orchestrator/start", async (req, res) => {
  const result = await proxyJsonRequest(
    "http://127.0.0.1:8060/orchestrator/start",
    "POST",
    req.body ?? {},
    60000
  );
  res.status(result.status).json(result.data);
});

app.post("/api/orchestrator/cancel/:jobId", async (req, res) => {
  const jobId = encodeURIComponent(String(req.params.jobId || ""));
  const result = await proxyJsonRequest(
    `http://127.0.0.1:8060/orchestrator/cancel/${jobId}`,
    "POST",
    undefined,
    30000
  );
  res.status(result.status).json(result.data);
});

app.get("/api/memory/projects", async (_req, res) => {
  const result = await proxyJsonRequest("http://127.0.0.1:8070/memory/projects");
  res.status(result.status).json(result.data);
});

app.get("/api/memory/list/:projectId", async (req, res) => {
  const projectId = encodeURIComponent(String(req.params.projectId || ""));
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
  const result = await proxyJsonRequest(
    `http://127.0.0.1:8070/memory/list/${projectId}?limit=${limit}`
  );
  res.status(result.status).json(result.data);
});

app.get("/api/memory/:memoryId", async (req, res) => {
  const memoryId = encodeURIComponent(String(req.params.memoryId || ""));
  const result = await proxyJsonRequest(`http://127.0.0.1:8070/memory/${memoryId}`);
  res.status(result.status).json(result.data);
});

app.post("/api/memory/add", async (req, res) => {
  const result = await proxyJsonRequest(
    "http://127.0.0.1:8070/memory/add",
    "POST",
    req.body ?? {},
    30000
  );
  res.status(result.status).json(result.data);
});

app.post("/api/memory/search", async (req, res) => {
  const result = await proxyJsonRequest(
    "http://127.0.0.1:8070/memory/search",
    "POST",
    req.body ?? {},
    30000
  );
  res.status(result.status).json(result.data);
});

app.post("/api/memory/context", async (req, res) => {
  const result = await proxyJsonRequest(
    "http://127.0.0.1:8070/memory/context",
    "POST",
    req.body ?? {},
    30000
  );
  res.status(result.status).json(result.data);
});

app.delete("/api/memory/project/:projectId", async (req, res) => {
  const projectId = encodeURIComponent(String(req.params.projectId || ""));
  const result = await proxyJsonRequest(
    `http://127.0.0.1:8070/memory/project/${projectId}`,
    "DELETE",
    undefined,
    30000
  );
  res.status(result.status).json(result.data);
});

app.delete("/api/memory/:memoryId", async (req, res) => {
  const memoryId = encodeURIComponent(String(req.params.memoryId || ""));
  const result = await proxyJsonRequest(
    `http://127.0.0.1:8070/memory/${memoryId}`,
    "DELETE",
    undefined,
    30000
  );
  res.status(result.status).json(result.data);
});

app.get("/api/ollama/models", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"], { windowsHide: true });
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(1);
    const models = [];

    for (const line of lines) {
      const cols = line.trim().split(/\s{2,}/);
      const name = cols[0];
      if (!name) continue;

      let parameters = "";
      let quantization = "";
      let context = "";

      try {
        const { stdout: show } = await execFileAsync("ollama", ["show", name], { windowsHide: true });
        parameters = show.match(/parameters\s+([^\r\n]+)/)?.[1]?.trim() ?? "";
        quantization = show.match(/quantization\s+([^\r\n]+)/)?.[1]?.trim() ?? "";
        context = show.match(/context length\s+([0-9]+)/)?.[1]?.trim() ?? "";
      } catch {}

      models.push({
        name,
        size: cols[2] ?? "",
        parameters,
        quantization,
        context,
      });
    }

    res.json({ models });
  } catch {
    res.json({ models: [] });
  }
});

app.post("/api/ollama/start", async (_req, res) => {
  if (!(await ollamaOnline())) {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
  }
  res.json({ ok: true });
});

app.post("/api/ollama/stop", async (_req, res) => {
  try {
    await execFileAsync("taskkill", ["/IM", "ollama.exe", "/F"], { windowsHide: true });
  } catch {}
  res.json({ ok: true });
});

app.post("/api/wckd-auto", async (req, res) => {
  const {
    sessionId,
    messages,
    context,
    think,
    temperature,
    topP,
    projectId,
    memoryEnabled,
    saveResultToMemory,
  } = req.body ?? {};

  const chatSessionId = String(sessionId || "").trim();

  if (!chatSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatSessionId)) {
    return res.status(400).json({ error: "valid sessionId is required" });
  }

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages are required" });
  }

  const openAiMessages = openAiMessagesFromWckd(messages);
  const prompt = latestUserText(openAiMessages);
const executionIntent =
        hasExecutionIntent(prompt) &&
    !wantsExplanationOnly(prompt);

  const webIntent = webSearchIntent(prompt);
  const webQuery = webSearchQuery(prompt, webIntent);
  const webSearch = webIntent.useWeb
    ? await runWckdWebSearch(chatSessionId, webQuery, 5)
    : null;
  const webContext = webSearchContext(webSearch);

  const groundedMessages = webContext
    ? [
        {
          role: "system",
          content: webContext,
        },
        ...openAiMessages,
      ]
    : openAiMessages;

  const routeBody: any = {
    model: "wckd-auto",
    messages: groundedMessages,
  };

  // Router v1.7 classifies AGENTIC work only when tools are available.
  // This synthetic preview tool truthfully signals that WCKD can execute work
  // through Agent Runner / Orchestrator without exposing a fake tool to Ollama.
  if (executionIntent) {
    routeBody.tools = [{
      type: "function",
      function: {
        name: "wckd_execute_task",
        description: "Execute a multi-step local WCKD task through Orchestrator.",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string" },
          },
          required: ["objective"],
        },
      },
    }];
  }

  let route: any;

  try {
    route = await postJson(`${ROUTER_BASE}/router/route`, routeBody, 15000);
  } catch (err: any) {
    await appendChatAudit({
      event: "chat_failed",
      session_id: chatSessionId,
      model: "WCKD Auto",
      error: `Router preview failed: ${err?.message || err}`,
    });

    return res.status(502).json({
      error: `WCKD Auto Router failed: ${err?.message || err}`,
    });
  }

  const routedTask = String(route?.task || "GENERAL").toUpperCase();
  const routedModel = String(route?.model || "qwen3.5:9b");
  const routedReason = String(route?.reason || "router");
  const useOrchestrator =
    executionIntent ||
    routedTask === "AGENTIC";

  await appendChatAudit({
    event: "auto_route",
    session_id: chatSessionId,
    mode: useOrchestrator ? "orchestrator" : "direct",
    task: routedTask,
    model: routedModel,
    reason: routedReason,
    prompt: prompt.length > 180 ? `${prompt.slice(0, 180)}…` : prompt,
    web_used: Boolean(webContext),
    web_query: webQuery || null,
    web_provider: webSearch?.provider || null,
    web_results: Array.isArray(webSearch?.results) ? webSearch.results.length : 0,
  });

  if (useOrchestrator) {
    const objective = webContext
      ? [
          prompt || "Complete the requested task.",
          "",
          "Use this WCKD web research as current external context:",
          webContext,
        ].join("\n")
      : (prompt || "Complete the requested task.");
    const project = String(projectId || "").trim();
    const startedAt = Date.now();

    let startData: any;

    try {
      startData = await postJson(
        `${ORCHESTRATOR_BASE}/orchestrator/start`,
        {
          objective,
          project_id: project || undefined,
          memory_enabled: project ? memoryEnabled !== false : false,
          save_result_to_memory: project ? saveResultToMemory !== false : false,
        },
        30000
      );
    } catch (err: any) {
      await appendChatAudit({
        event: "auto_orchestrator_failed",
        session_id: chatSessionId,
        error: err?.message || String(err),
      });

      return res.status(502).json({
        error: `Orchestrator start failed: ${err?.message || err}`,
      });
    }

    const jobId = String(startData?.job_id || "");

    await appendChatAudit({
      event: "auto_orchestrator_started",
      session_id: chatSessionId,
      job_id: jobId,
      project_id: project || null,
      memory_used: startData?.memory_used === true,
      memory_citations: Number(startData?.memory_citations || 0),
    });

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const writeChunk = (payload: any) => {
      if (!res.writableEnded) {
        res.write(JSON.stringify(payload) + "\n");
      }
    };

    writeChunk({
      message: {
        thinking: `WCKD Auto → Orchestrator\njob=${jobId}\n`,
      },
      done: false,
    });

    let lastStage = "";
    let lastProgress = "";
    let finalStatus: any = null;

    try {
      const deadline = Date.now() + 35 * 60 * 1000;

      while (Date.now() < deadline) {
        if (req.aborted || res.writableEnded) break;

        const statusResponse = await fetch(
          `${ORCHESTRATOR_BASE}/orchestrator/status/${encodeURIComponent(jobId)}`
        );

        if (!statusResponse.ok) {
          throw new Error(`Orchestrator status HTTP ${statusResponse.status}`);
        }

        const status = await statusResponse.json();
        finalStatus = status;

        const progress = status?.progress
          ? `${status.progress.completed_stages ?? 0}/${status.progress.total_stages ?? 0}`
          : "";

        const stage = String(status?.current_stage || status?.status || "");

        if (stage !== lastStage || progress !== lastProgress) {
          lastStage = stage;
          lastProgress = progress;

          await appendChatAudit({
            event: "auto_orchestrator_stage",
            session_id: chatSessionId,
            job_id: jobId,
            stage,
            progress,
            runner_status: status?.runner_status?.status || null,
            runner_step: status?.runner_status?.step ?? null,
          });

          writeChunk({
            message: {
              thinking: `${stage}${progress ? ` · ${progress}` : ""}\n`,
            },
            done: false,
          });
        }

        const terminal = ["completed", "failed", "cancelled", "interrupted"];
        if (terminal.includes(String(status?.status || ""))) break;

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!finalStatus || String(finalStatus.status) !== "completed") {
        const error =
          finalStatus?.last_error ||
          `Orchestrator ended with status ${finalStatus?.status || "timeout"}`;

        await appendChatAudit({
          event: "auto_orchestrator_failed",
          session_id: chatSessionId,
          job_id: jobId,
          error,
        });

        writeChunk({ error });
        res.end();
        return;
      }

      const resultResponse = await fetch(
        `${ORCHESTRATOR_BASE}/orchestrator/result/${encodeURIComponent(jobId)}`
      );

      if (!resultResponse.ok) {
        throw new Error(`Orchestrator result HTTP ${resultResponse.status}`);
      }

      const result = await resultResponse.json();
      const finalText = String(
        result?.final_response ||
        result?.last_output ||
        "Task completed."
      );

      const execution = await executionMetadataFromOrchestratorResult(result, jobId);

      await appendChatAudit({
        event: "auto_orchestrator_completed",
        session_id: chatSessionId,
        job_id: jobId,
        total_seconds: (Date.now() - startedAt) / 1000,
        memory_used: result?.memory_used === true,
        memory_citations: Array.isArray(result?.memory_citations)
          ? result.memory_citations.length
          : Number(result?.memory_citations || 0),
        saved_memory: result?.saved_memory?.memory_id || null,
        verified: execution.verified,
        recovered: execution.recovered,
        verification_gate_passed: execution.verificationGatePassed,
        runner_job_id: execution.runnerJobId || null,
        successful_tool_results: execution.successfulToolResults,
        failed_tool_results: execution.failedToolResults,
      });

      writeChunk({
        execution,
        done: false,
      });

      writeChunk({
        message: { content: finalText },
        done: false,
      });

      writeChunk({
        done: true,
        total_duration: (Date.now() - startedAt) * 1_000_000,
      });

      res.end();
      return;
    } catch (err: any) {
      await appendChatAudit({
        event: "auto_orchestrator_failed",
        session_id: chatSessionId,
        job_id: jobId,
        error: err?.message || String(err),
      });

      writeChunk({ error: err?.message || "Orchestrator execution failed" });
      res.end();
      return;
    }
  }

  // Direct WCKD Auto path: execute the Router-selected model through Router v1.7.
  const requestId = `auto-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const startedAt = Date.now();

  await appendChatAudit({
    event: "chat_started",
    session_id: chatSessionId,
    request_id: requestId,
    model: routedModel,
    routed_task: routedTask,
    mode: "text",
    prompt: prompt.length > 180 ? `${prompt.slice(0, 180)}…` : prompt,
  });

  const routerPayload: any = {
    model: "wckd-auto",
    messages: groundedMessages,
    stream: true,
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.55,
    top_p: Number.isFinite(Number(topP)) ? Number(topP) : 0.95,
  };

  if (Number(context) > 0) {
    routerPayload.num_ctx = Number(context);
  }

  const upstreamAbort = new AbortController();

  const abortUpstream = () => {
    if (!res.writableEnded && !upstreamAbort.signal.aborted) {
      upstreamAbort.abort();
    }
  };

  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);

  try {
    const upstream = await fetch(`${ROUTER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routerPayload),
      signal: upstreamAbort.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();

      await appendChatAudit({
        event: "chat_failed",
        session_id: chatSessionId,
        request_id: requestId,
        model: routedModel,
        error: detail || `Router HTTP ${upstream.status}`,
      });

      return res.status(upstream.status).send(detail || "WCKD Auto direct route failed");
    }

    const headerModel = upstream.headers.get("x-wckd-routed-model");
    const headerTask = upstream.headers.get("x-wckd-task");
    const finalModel = headerModel || routedModel;

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstTokenLogged = false;
    let completionTokens = 0;
    let promptTokens = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = eventText
          .split(/\r?\n/)
          .find(line => line.startsWith("data:"));

        if (!dataLine) continue;

        const payloadText = dataLine.slice(5).trim();
        if (!payloadText || payloadText === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (chunk?.error) {
          const error =
            chunk.error?.message ||
            chunk.error ||
            "WCKD Router stream error";

          await appendChatAudit({
            event: "chat_failed",
            session_id: chatSessionId,
            request_id: requestId,
            model: finalModel,
            error,
          });

          res.write(JSON.stringify({ error }) + "\n");
          continue;
        }

        const delta = chunk?.choices?.[0]?.delta || {};
        const content = String(delta?.content || "");
        const reasoning = String(
          delta?.reasoning ||
          delta?.reasoning_content ||
          ""
        );

        if ((content || reasoning) && !firstTokenLogged) {
          firstTokenLogged = true;

          await appendChatAudit({
            event: "chat_first_token",
            session_id: chatSessionId,
            request_id: requestId,
            model: finalModel,
            first_token_ms: Date.now() - startedAt,
          });
        }

        if (content || reasoning) {
          res.write(JSON.stringify({
            message: {
              ...(content ? { content } : {}),
              ...(reasoning ? { thinking: reasoning } : {}),
            },
            done: false,
          }) + "\n");
        }

        if (chunk?.usage) {
          promptTokens = Number(chunk.usage.prompt_tokens || promptTokens || 0);
          completionTokens = Number(chunk.usage.completion_tokens || completionTokens || 0);
        }
      }
    }

    const totalSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const generationTps = completionTokens > 0
      ? completionTokens / totalSeconds
      : null;

    await appendChatAudit({
      event: "chat_completed",
      session_id: chatSessionId,
      request_id: requestId,
      model: finalModel,
      routed_task: headerTask || routedTask,
      prompt_tokens: promptTokens || null,
      output_tokens: completionTokens || null,
      generation_tps: generationTps,
      total_seconds: totalSeconds,
    });

    const sourcesFooter = webSourcesFooter(webSearch);
    if (sourcesFooter) {
      res.write(JSON.stringify({
        message: { content: sourcesFooter },
        done: false,
      }) + "\n");
    }

    res.write(JSON.stringify({
      done: true,
      prompt_eval_count: promptTokens || undefined,
      eval_count: completionTokens || undefined,
      eval_duration:
        completionTokens > 0 && generationTps
          ? Math.round((completionTokens / generationTps) * 1e9)
          : undefined,
      total_duration: Math.round(totalSeconds * 1e9),
    }) + "\n");

    res.end();
  } catch (err: any) {
    const isAbort = err?.name === "AbortError" || upstreamAbort.signal.aborted;

    await appendChatAudit({
      event: isAbort ? "chat_aborted" : "chat_failed",
      session_id: chatSessionId,
      request_id: requestId,
      model: routedModel,
      error: isAbort ? "client aborted" : (err?.message || String(err)),
    });

    if (!res.headersSent) {
      res.status(isAbort ? 499 : 502).json({
        error: isAbort
          ? "WCKD Auto request aborted"
          : (err?.message || "WCKD Auto direct route failed"),
      });
    } else {
      res.end();
    }
  } finally {
    req.removeListener("aborted", abortUpstream);
    res.removeListener("close", abortUpstream);
  }
});

app.post("/api/chat", async (req, res) => {
  const { model, sessionId, messages, context, think, temperature, topP } = req.body ?? {};

  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "model and messages are required" });
  }

  const chatSessionId = String(sessionId || "").trim();
  if (!chatSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatSessionId)) {
    return res.status(400).json({ error: "valid sessionId is required" });
  }

  const imageCount = messages.reduce((count: number, message: any) => {
    return count + (Array.isArray(message?.images) ? message.images.length : 0);
  }, 0);

  if (imageCount > 6) {
    return res.status(400).json({ error: "maximum 6 images per chat request" });
  }

  const requestId = `chat-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const startedAt = Date.now();
  const promptPreview = lastUserPreview(messages);

  await appendChatAudit({
    event: "chat_started",
    session_id: chatSessionId,
    request_id: requestId,
    model,
    mode: "text",
    context: Number(context) || 16384,
    think: think || "off",
    prompt: promptPreview,
  });

  const abort = new AbortController();

  const abortUpstream = () => {
    if (!res.writableEnded && !abort.signal.aborted) {
      abort.abort();
    }
  };

  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);

  let firstTokenLogged = false;
  let auditBuffer = "";
  const auditDecoder = new TextDecoder();

  try {
    const upstream = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: think === "off" ? false : (think || false),
        options: {
          num_ctx: Number(context) || 16384,
          temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.55,
          top_p: Number.isFinite(Number(topP)) ? Number(topP) : 0.95,
        },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text();

      await appendChatAudit({
        event: "chat_failed",
        session_id: chatSessionId,
        request_id: requestId,
        model,
        error: errorText || `Ollama HTTP ${upstream.status}`,
        http_status: upstream.status,
      });

      return res.status(upstream.status).send(errorText || "Ollama chat request failed");
    }

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const rawChunk = Buffer.from(value);
        res.write(rawChunk);

        auditBuffer += auditDecoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = auditBuffer.indexOf("\n")) >= 0) {
          const line = auditBuffer.slice(0, newlineIndex).trim();
          auditBuffer = auditBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          let chunk: any;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }

          const hasToken = Boolean(chunk?.message?.content || chunk?.message?.thinking);

          if (hasToken && !firstTokenLogged) {
            firstTokenLogged = true;
            await appendChatAudit({
              event: "chat_first_token",
              session_id: chatSessionId,
              request_id: requestId,
              model,
              first_token_ms: Date.now() - startedAt,
            });
          }

          if (chunk?.done) {
            const evalSeconds = Number(chunk.eval_duration || 0) / 1e9;
            const totalSeconds =
              chunk.total_duration
                ? Number(chunk.total_duration) / 1e9
                : (Date.now() - startedAt) / 1000;

            await appendChatAudit({
              event: "chat_completed",
              session_id: chatSessionId,
              request_id: requestId,
              model,
              prompt_tokens: chunk.prompt_eval_count ?? null,
              output_tokens: chunk.eval_count ?? null,
              generation_tps:
                evalSeconds > 0 && chunk.eval_count != null
                  ? Number(chunk.eval_count) / evalSeconds
                  : null,
              total_seconds: totalSeconds,
            });
          }
        }
      }
    } finally {
      res.end();
    }
  } catch (err: any) {
    const isAbort = err?.name === "AbortError" || abort.signal.aborted;

    await appendChatAudit({
      event: isAbort ? "chat_aborted" : "chat_failed",
      session_id: chatSessionId,
      request_id: requestId,
      model,
      error: isAbort ? "client aborted" : (err?.message || "Chat proxy failed"),
    });

    if (!res.headersSent) {
      res.status(isAbort ? 499 : 500).json({
        error: isAbort ? "Chat request aborted" : (err?.message || "Chat proxy failed"),
      });
    } else {
      res.end();
    }
  } finally {
    req.removeListener("aborted", abortUpstream);
    res.removeListener("close", abortUpstream);
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`WCKD Core API v0.9.6 listening on http://127.0.0.1:${PORT}`);
});
