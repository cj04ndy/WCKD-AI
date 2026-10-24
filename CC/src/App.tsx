import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Image, Video, AudioLines, Boxes, Settings, Power,
  MessageSquare, Sparkles, Circle, RefreshCw, Play, Square,
  ChevronRight, WandSparkles, SlidersHorizontal, Plus, Send,
  Trash2, Brain, ChevronDown, Copy, Check, PanelLeftClose, PanelLeftOpen,
  RotateCcw, Gauge, Activity, Database, Workflow, ShieldCheck, Server, Cpu, Terminal, Paperclip, FileText, X
} from "lucide-react";

type Page = "home" | "chat" | "orchestrator" | "memory" | "image" | "video" | "audio" | "models" | "services" | "settings";

type WorkflowMode = "auto" | "fast" | "full";

type OllamaModel = {
  name: string;
  size: string;
  parameters?: string;
  quantization?: string;
  context?: string;
};

type ChatAttachment = {
  id: string;
  name: string;
  kind: "text";
  mime: string;
  size: number;
  data?: string;
  text?: string;
  truncated?: boolean;
};

type ExecutionEvidenceEvent = {
  event?: string;
  step?: number;
  tool?: string;
  ok?: boolean;
  result?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  message?: string;
};

type ExecutionEvidence = {
  verified: boolean;
  recovered?: boolean;
  orchestratorJobId?: string;
  runnerJobId?: string;
  workspace?: string;
  verificationGatePassed?: boolean;
  verificationSuccessSeen?: boolean;
  verificationFailureSeen?: boolean;
  successfulToolResults?: number;
  failedToolResults?: number;
  evidenceSource?: string;
  evidencePacket?: string;
  evidenceEvents?: ExecutionEvidenceEvent[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  execution?: ExecutionEvidence;
  attachments?: ChatAttachment[];
  createdAt?: number;
};

type ChatSession = {
  id: string;
  title: string;
  model: string;
  context: number;
  thinking: boolean;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  profile?: "fast" | "balanced" | "deep";
  temperature?: number;
  topP?: number;
  systemPrompt?: string;
  projectId?: string;
  memoryEnabled?: boolean;
  saveResultToMemory?: boolean;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

type RunStats = {
  promptTokens?: number;
  outputTokens?: number;
  generationTokS?: number;
  promptTokS?: number;
  totalSeconds?: number;
};

type ServiceState = {
  key: string;
  label: string;
  port: number;
  target: string;
  status: "online" | "degraded" | "offline" | "error";
  online: boolean;
  optional?: boolean;
  version?: string;
  detail?: string;
};

type ServiceLogResponse = {
  target: string;
  label: string;
  lines: number;
  files: string[];
  output: string;
};

type LiveConsoleEvent = {
  id: string;
  ts: string;
  source: string;
  level: "info" | "warn" | "error" | "success";
  kind: "work" | "error" | "raw";
  event: string;
  text: string;
  data?: Record<string, any>;
};

type LiveConsoleResponse = {
  status: string;
  version: string;
  events: LiveConsoleEvent[];
  meta?: {
    orchestrator?: {
      job_id?: string | null;
      status?: string | null;
      stage?: string | null;
      progress?: string | null;
    };
    runner?: {
      job_id?: string | null;
      status?: string | null;
      step?: number | null;
      max_steps?: number | null;
      activity?: string | null;
      model?: string | null;
    };
    model?: {
      active_model?: string | null;
      state_model?: string | null;
    };
  };
};

type SpecialistProfile = {
  id: string;
  model: string;
  fallback?: string[];
  route?: string;
  tools?: string;
  temperature?: number;
  maxSteps?: number;
};

type OrchestratorJob = {
  job_id: string;
  status: string;
  workspace?: string;
  current_stage?: string | null;
  progress?: {
    completed_stages?: number;
    total_stages?: number;
  };
  created?: string;
  updated?: string;
  completed?: string | null;
  last_error?: string | null;
};

type OrchestratorResult = {
  job_id: string;
  status: string;
  objective?: string;
  workspace?: string;
  project_id?: string | null;
  memory_used?: boolean;
  memory_citations?: Array<{
    memory_id?: string;
    title?: string;
    source?: string;
    kind?: string;
    created_at?: string;
  }>;
  memory_context_chars?: number;
  saved_memory?: {
    memory_id?: string;
    created?: boolean;
    deduplicated?: boolean;
  } | null;
  memory_save_error?: string | null;
  stage_results?: Array<{
    id?: string;
    type?: string;
    specialist?: string;
    status?: string;
    model?: string;
    duration_seconds?: number;
    output?: string;
    runner_job_id?: string;
    runner_status?: string;
  }>;
  final_response?: string | null;
  last_error?: string | null;
  created?: string;
  started?: string | null;
  completed?: string | null;
};

type MemoryProject = {
  project_id: string;
  memories: number;
  updated_at?: string;
};

type MemoryItem = {
  memory_id: string;
  project_id: string;
  title?: string;
  source?: string;
  kind?: string;
  text: string;
  tags?: string[];
  metadata?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
  rank?: number;
};

type StackState = {
  version: string;
  overall: "online" | "degraded" | "offline";
  onlineCount: number;
  total: number;
  optionalOnlineCount?: number;
  optionalTotal?: number;
  services: ServiceState[];
  managerStatus?: Record<string, any> | null;
  registry?: {
    count?: number;
    valid?: boolean;
  } | null;
  orchestrator?: {
    activeJobId?: string | null;
    queued?: number;
    running?: number;
  } | null;
  memory?: {
    projects?: number;
    memories?: number;
    retrieval?: string;
    databaseOk?: boolean;
  } | null;
  gpu?: {
    name?: string;
    memoryUsedMB?: number;
    memoryTotalMB?: number;
    utilization?: number;
    temperature?: number;
  } | null;
};

const API = "http://127.0.0.1:17888";
const UI_ZOOM_STORE = "wckd-ui-zoom";
const LIVE_CONSOLE_STORE = "wckd-live-console-open";
const LIVE_CONSOLE_MAX_EVENTS = 600;
const UI_ZOOM_MIN = 60;
const UI_ZOOM_MAX = 160;
const UI_ZOOM_STEP = 5;

function clampUiZoom(value: number) {
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(value / UI_ZOOM_STEP) * UI_ZOOM_STEP));
}
const CHAT_STORE = "wckd.chat.sessions.v1";
const ACTIVE_CHAT_STORE = "wckd.chat.active.v1";
const WCKD_AUTO_MODEL = "__wckd_auto__";
const CHAT_ACTIVITY_STORE = "wckd.chat.activity.open.v1";

const CHAT_MAX_ATTACHMENTS = 6;
const CHAT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CHAT_MAX_TEXT_BYTES = 256 * 1024;
const CHAT_MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024;

const CHAT_TEXT_EXTENSIONS = new Set([
  "txt","md","markdown","json","jsonl","csv","tsv",
  "js","jsx","ts","tsx","mjs","cjs",
  "py","ps1","psm1","bat","cmd","sh",
  "html","htm","css","scss","less",
  "xml","yaml","yml","toml","ini","cfg","conf","log","env",
  "sql","c","cpp","cc","h","hpp","cs","java","go","rs","php","rb",
  "gd","godot","tres","tscn","shader"
]);

function fileExtension(name: string) {
  const clean = String(name || "").toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index + 1) : "";
}

function formatFileBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatChatTimestamp(value?: number) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (sameDay) return time;

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month} · ${time}`;
}

function isSupportedTextFile(file: File) {
  return String(file.type || "").toLowerCase().startsWith("text/") ||
    CHAT_TEXT_EXTENSIONS.has(fileExtension(file.name));
}

function attachmentMessageContent(message: ChatMessage) {
  let content = message.content || "";
  const attachments = message.attachments ?? [];

  for (const attachment of attachments) {
    if (attachment.kind === "text" && attachment.text !== undefined) {
      const suffix = attachment.truncated
        ? "\\n[File truncated to the first 256 KB by WCKD Control Center.]"
        : "";

      content += (
        `\\n\\n--- ATTACHED FILE: ${attachment.name} ---\\n` +
        `${attachment.text}${suffix}\\n` +
        `--- END ATTACHED FILE: ${attachment.name} ---`
      );
    }

}

  return content;
}

function ollamaChatMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: attachmentMessageContent(message),
  };
}

function wckdAutoChatMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: attachmentMessageContent(message),
  };
}

const nav = [
  { id: "home" as Page, label: "Home", icon: Sparkles },
  { id: "chat" as Page, label: "Chat & Agents", icon: MessageSquare },
  { id: "orchestrator" as Page, label: "Orchestrator", icon: Workflow },
  { id: "memory" as Page, label: "Project Memory", icon: Database },
  { id: "image" as Page, label: "Image", icon: Image },
  { id: "video" as Page, label: "Video", icon: Video },
  { id: "audio" as Page, label: "Audio", icon: AudioLines },
  { id: "models" as Page, label: "Models", icon: Boxes },
  { id: "services" as Page, label: "Services", icon: Power },
  { id: "settings" as Page, label: "Settings", icon: Settings },
];

const ctxOptions = [
  { label: "4K", value: 4096 },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function supportsThinking(model: string) {
  const m = model.toLowerCase();
  return m.includes("qwen3") || m.includes("gpt-oss");
}

function thinkingChoices(model: string) {
  const m = model.toLowerCase();
  if (m.includes("gpt-oss")) return ["off", "low", "medium", "high"] as const;
  if (m.includes("qwen3")) return ["off", "medium"] as const;
  return ["off"] as const;
}

function profileDefaults(profile: "fast" | "balanced" | "deep") {
  if (profile === "fast") return { context: 8192, temperature: 0.35, topP: 0.90, thinkingLevel: "off" as const };
  if (profile === "deep") return { context: 32768, temperature: 0.65, topP: 0.95, thinkingLevel: "high" as const };
  return { context: 16384, temperature: 0.55, topP: 0.95, thinkingLevel: "medium" as const };
}

const FAST_WORKFLOW_STAGES = [
  {
    id: "answer",
    type: "chat",
    specialist: "GENERAL",
    instruction: (
      "Answer the original objective directly. Use Project Memory context when present. " +
      "Do not execute tools, create files or claim work that was not performed. " +
      "Keep the answer focused on the requested information."
    ),
  },
];

function shouldUseFastWorkflow(objective: string, workspace: string) {
  const text = objective.trim().toLowerCase();
  if (!text || workspace.trim()) return false;

  const executionIntent =
    /\b(create|write|edit|modify|change|delete|remove|install|build|run|execute|test|fix|patch|deploy|download|move|copy|rename|generate|save|compile|launch|start|stop|file|folder|directory|workspace|script|code|project)\b/;

  if (executionIntent.test(text)) return false;

  return (
    text.includes("?") ||
    /^(what|which|who|why|how|when|where|explain|summarize|tell me|according to|from project memory)\b/.test(text)
  );
}

function Pill({ online, children }: { online: boolean; children: React.ReactNode }) {
  return (
    <span className={`pill ${online ? "online" : "offline"}`}>
      <Circle size={7} fill="currentColor" /> {children}
    </span>
  );
}

function StatusPill({
  status,
  children,
}: {
  status: "online" | "degraded" | "offline" | "error";
  children: React.ReactNode;
}) {
  return (
    <span className={`pill ${status}`}>
      <Circle size={7} fill="currentColor" /> {children}
    </span>
  );
}

function ModuleCard({
  title, subtitle, status, icon: Icon, onOpen,
}: {
  title: string; subtitle: string; status: string; icon: any; onOpen: () => void;
}) {
  return (
    <button className="module-card" onClick={onOpen}>
      <div className="module-icon"><Icon size={22} /></div>
      <div className="module-copy">
        <div className="module-title">{title}</div>
        <div className="module-sub">{subtitle}</div>
        <div className="module-status">{status}</div>
      </div>
      <ChevronRight size={20} className="chevron" />
    </button>
  );
}

function fmtMemory(value?: number) {
  if (!Number.isFinite(value)) return "—";
  const n = Number(value);
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  return `${Math.round(n)} MB`;
}

function titleStatus(status?: string) {
  if (!status) return "OFFLINE";
  return status.toUpperCase();
}

function managerActiveModel(stack: StackState | null) {
  const s = stack?.managerStatus || {};
  return String(
    s.active_model ??
    s.loaded_model ??
    s.model ??
    s.requested_model ??
    "—"
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [uiZoom, setUiZoom] = useState<number>(() => {
    const saved = Number(localStorage.getItem(UI_ZOOM_STORE) || "100");
    return Number.isFinite(saved) ? clampUiZoom(saved) : 100;
  });
  const [liveConsoleOpen, setLiveConsoleOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(LIVE_CONSOLE_STORE);
    return saved === null ? true : saved === "1";
  });
  const [liveConsolePaused, setLiveConsolePaused] = useState(false);
  const [liveConsoleFilter, setLiveConsoleFilter] = useState<"all" | "work" | "errors">("work");
  const [liveConsoleEvents, setLiveConsoleEvents] = useState<LiveConsoleEvent[]>([]);
  const [liveConsoleMeta, setLiveConsoleMeta] = useState<LiveConsoleResponse["meta"]>({});
  const [liveConsoleAutoScroll, setLiveConsoleAutoScroll] = useState(true);
  const liveConsoleSeenRef = useRef<Set<string>>(new Set());
  const liveConsoleEndRef = useRef<HTMLDivElement>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState(false);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [stack, setStack] = useState<StackState | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [diagnosticOutput, setDiagnosticOutput] = useState("");
  const [selectedServiceKey, setSelectedServiceKey] = useState("router");
  const [serviceLog, setServiceLog] = useState<ServiceLogResponse | null>(null);
  const [serviceLogLoading, setServiceLogLoading] = useState(false);
  const [specialists, setSpecialists] = useState<SpecialistProfile[]>([]);
  const [modelAction, setModelAction] = useState("");

  const [orchestratorJobs, setOrchestratorJobs] = useState<OrchestratorJob[]>([]);
  const [orchestratorResult, setOrchestratorResult] = useState<OrchestratorResult | null>(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [orchestratorPipeline, setOrchestratorPipeline] = useState<any[]>([]);
  const [orchestratorBusy, setOrchestratorBusy] = useState("");
  const [orchestratorObjective, setOrchestratorObjective] = useState("");
  const [orchestratorWorkspace, setOrchestratorWorkspace] = useState("");
  const [orchestratorProject, setOrchestratorProject] = useState("");
  const [orchestratorMemoryEnabled, setOrchestratorMemoryEnabled] = useState(true);
  const [orchestratorSaveMemory, setOrchestratorSaveMemory] = useState(true);
  const [orchestratorWorkflowMode, setOrchestratorWorkflowMode] = useState<WorkflowMode>("auto");

  const [memoryProjects, setMemoryProjects] = useState<MemoryProject[]>([]);
  const [memoryProject, setMemoryProject] = useState("");
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<MemoryItem | null>(null);
  const [memorySearch, setMemorySearch] = useState("");
  const [memorySearchResults, setMemorySearchResults] = useState<MemoryItem[]>([]);
  const [memoryContext, setMemoryContext] = useState("");
  const [memoryBusy, setMemoryBusy] = useState("");
  const [memoryNewProject, setMemoryNewProject] = useState("");
  const [memoryNewTitle, setMemoryNewTitle] = useState("");
  const [memoryNewKind, setMemoryNewKind] = useState("note");
  const [memoryNewTags, setMemoryNewTags] = useState("");
  const [memoryNewText, setMemoryNewText] = useState("");

  async function refreshRuntime() {
    try {
      const health = await fetch(`${API}/api/health`).then(r => r.json());
      setApiOnline(true);
      setOllamaOnline(Boolean(health.ollama));
    } catch {
      setApiOnline(false);
      setOllamaOnline(false);
    }

    try {
      const data = await fetch(`${API}/api/stack`).then(r => {
        if (!r.ok) throw new Error(`Stack HTTP ${r.status}`);
        return r.json();
      });
      setStack(data);
    } catch {
      setStack(null);
    }
  }

  async function refreshModels() {
    try {
      const data = await fetch(`${API}/api/ollama/models`).then(r => r.json());
      setModels(data.models ?? []);
    } catch {
      setModels([]);
    }
  }

  async function refreshSpecialists() {
    try {
      const response = await fetch(`${API}/api/specialists`);
      const data = await response.json();
      setSpecialists(Array.isArray(data.specialists) ? data.specialists : []);
    } catch {
      setSpecialists([]);
    }
  }

  async function refreshOrchestrator() {
    try {
      const [jobsResponse, workflowsResponse] = await Promise.all([
        fetch(`${API}/api/orchestrator/jobs?limit=30`),
        fetch(`${API}/api/orchestrator/workflows`),
      ]);

      const jobsData = await jobsResponse.json();
      const workflowsData = await workflowsResponse.json();

      const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
      setOrchestratorJobs(jobs);
      setOrchestratorPipeline(Array.isArray(workflowsData.default) ? workflowsData.default : []);

      const nextId = selectedJobId || jobs[0]?.job_id || "";
      if (!selectedJobId && nextId) setSelectedJobId(nextId);

      if (nextId) {
        const resultResponse = await fetch(`${API}/api/orchestrator/result/${encodeURIComponent(nextId)}`);
        if (resultResponse.ok) {
          setOrchestratorResult(await resultResponse.json());
        }
      } else {
        setOrchestratorResult(null);
      }
    } catch {
      setOrchestratorJobs([]);
    }
  }

  async function refreshMemoryProjects() {
    try {
      const response = await fetch(`${API}/api/memory/projects`);
      const data = await response.json();
      const projects = Array.isArray(data.projects) ? data.projects : [];
      setMemoryProjects(projects);

      if (!memoryProject && projects.length) {
        setMemoryProject(projects[0].project_id);
      }
    } catch {
      setMemoryProjects([]);
    }
  }

  async function loadMemoryProject(projectId: string) {
    if (!projectId) {
      setMemoryItems([]);
      return;
    }

    try {
      const response = await fetch(`${API}/api/memory/list/${encodeURIComponent(projectId)}?limit=100`);
      const data = await response.json();
      setMemoryItems(Array.isArray(data.memories) ? data.memories : []);
    } catch {
      setMemoryItems([]);
    }
  }

  function setConsoleOpen(next: boolean) {
    setLiveConsoleOpen(next);
    localStorage.setItem(LIVE_CONSOLE_STORE, next ? "1" : "0");
  }

  function clearLiveConsole() {
    setLiveConsoleEvents([]);
    // Keep seen IDs so Clear actually stays clear until new events arrive.
  }

  async function copyLiveConsole() {
    const lines = filteredConsoleEvents.map(event =>
      `${event.ts || ""} [${event.source}] ${event.event} ${event.text}`.trim()
    );

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setDiagnosticOutput(`Copied ${lines.length} Live Console events.`);
    } catch {
      setDiagnosticOutput("ERROR: Could not copy Live Console events.");
    }
  }

  async function refreshLiveConsole() {
    if (!liveConsoleOpen || liveConsolePaused) return;

    try {
      const response = await fetch(`${API}/api/live-console?limit=240`);
      const data: LiveConsoleResponse = await response.json();
      if (!response.ok) return;

      setLiveConsoleMeta(data.meta ?? {});

      const incoming = Array.isArray(data.events) ? data.events : [];
      const fresh: LiveConsoleEvent[] = [];

      for (const event of incoming) {
        if (!event?.id || liveConsoleSeenRef.current.has(event.id)) continue;
        liveConsoleSeenRef.current.add(event.id);
        fresh.push(event);
      }

      if (fresh.length) {
        setLiveConsoleEvents(current =>
          [...current, ...fresh]
            .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
            .slice(-LIVE_CONSOLE_MAX_EVENTS)
        );
      }
    } catch {
      // Main stack health already communicates API availability.
    }
  }

  async function refreshAll() {
    await Promise.all([
      refreshRuntime(),
      refreshModels(),
      refreshSpecialists(),
      refreshOrchestrator(),
      refreshMemoryProjects(),
    ]);
  }

  function syncZoomViewport(zoomPercent: number) {
    const factor = Math.max(0.01, zoomPercent / 100);
    const compensatedHeight = window.innerHeight / factor;
    document.documentElement.style.setProperty(
      "--wckd-viewport-height",
      `${compensatedHeight}px`
    );
  }

  function applyUiZoom(nextValue: number) {
    const next = clampUiZoom(nextValue);
    setUiZoom(next);
    localStorage.setItem(UI_ZOOM_STORE, String(next));
    document.documentElement.style.setProperty("zoom", String(next / 100));
    syncZoomViewport(next);
  }

  function stepUiZoom(direction: 1 | -1) {
    setUiZoom(current => {
      const next = clampUiZoom(current + direction * UI_ZOOM_STEP);
      localStorage.setItem(UI_ZOOM_STORE, String(next));
      document.documentElement.style.setProperty("zoom", String(next / 100));
      syncZoomViewport(next);
      return next;
    });
  }

  useEffect(() => {
    document.documentElement.style.setProperty("zoom", String(uiZoom / 100));
    syncZoomViewport(uiZoom);

    const onResize = () => syncZoomViewport(uiZoom);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [uiZoom]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;

      const plus =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";

      const minus =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";

      const reset =
        event.key === "0" ||
        event.code === "Numpad0";

      if (plus) {
        event.preventDefault();
        stepUiZoom(1);
      } else if (minus) {
        event.preventDefault();
        stepUiZoom(-1);
      } else if (reset) {
        event.preventDefault();
        applyUiZoom(100);
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      if (event.deltaY < 0) {
        stepUiZoom(1);
      } else if (event.deltaY > 0) {
        stepUiZoom(-1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    refreshAll();
    const stackTimer = setInterval(refreshRuntime, 3000);
    const modelTimer = setInterval(refreshModels, 30000);
    return () => {
      clearInterval(stackTimer);
      clearInterval(modelTimer);
    };
  }, []);

  async function postAction(path: string, label: string, waitMs = 900) {
    setBusyAction(label);
    try {
      const response = await fetch(`${API}${path}`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.output || `${label} failed`);
      }
      if (data.output) setDiagnosticOutput(data.output);
      if (data.stderr) setDiagnosticOutput(prev => `${prev}${prev ? "\n\n" : ""}${data.stderr}`.trim());
      await new Promise(r => setTimeout(r, waitMs));
      await refreshRuntime();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || label}`);
    } finally {
      setBusyAction("");
    }
  }

  async function runModelAction(action: "load" | "switch" | "unload", model?: string) {
    const key = `${action}:${model ?? "active"}`;
    setModelAction(key);
    setDiagnosticOutput("");

    try {
      const suffix = model ? `/${encodeURIComponent(model)}` : "";
      const response = await fetch(`${API}/api/model-manager/${action}${suffix}`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.detail || data.output || `${action} failed`);
      }

      if (data.output) setDiagnosticOutput(String(data.output));
      await new Promise(resolve => setTimeout(resolve, 700));
      await refreshAll();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || `${action} failed`}`);
    } finally {
      setModelAction("");
    }
  }

  async function startOrchestratorJob() {
    if (!orchestratorObjective.trim()) {
      setDiagnosticOutput("ERROR: Orchestrator objective is required.");
      return;
    }

    const resolvedMode: "fast" | "full" =
      orchestratorWorkflowMode === "auto"
        ? (shouldUseFastWorkflow(orchestratorObjective, orchestratorWorkspace) ? "fast" : "full")
        : orchestratorWorkflowMode;

    setOrchestratorBusy("start");
    setDiagnosticOutput("");

    try {
      const response = await fetch(`${API}/api/orchestrator/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: orchestratorObjective.trim(),
          workspace: orchestratorWorkspace.trim() || undefined,
          project_id: orchestratorProject || undefined,
          memory_enabled: orchestratorMemoryEnabled,
          save_result_to_memory: orchestratorSaveMemory,
          stages: resolvedMode === "fast" ? FAST_WORKFLOW_STAGES : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Orchestrator start failed.");

      setSelectedJobId(String(data.job_id || ""));
      setOrchestratorWorkspace("");
      setDiagnosticOutput(
        `Queued ${data.job_id}\nMode: ${resolvedMode.toUpperCase()}\nWorkspace: ${data.workspace}\nMemory used: ${data.memory_used}\nMemory citations: ${data.memory_citations}`
      );

      await new Promise(resolve => setTimeout(resolve, 350));
      await refreshOrchestrator();
      await refreshRuntime();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Orchestrator start failed."}`);
    } finally {
      setOrchestratorBusy("");
    }
  }

  async function cancelOrchestratorJob(jobId: string) {
    if (!jobId) return;

    setOrchestratorBusy(`cancel:${jobId}`);
    try {
      const response = await fetch(`${API}/api/orchestrator/cancel/${encodeURIComponent(jobId)}`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Cancel failed.");
      setDiagnosticOutput(JSON.stringify(data, null, 2));
      await refreshOrchestrator();
      await refreshRuntime();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Cancel failed."}`);
    } finally {
      setOrchestratorBusy("");
    }
  }

  async function loadOrchestratorResult(jobId: string) {
    setSelectedJobId(jobId);
    try {
      const response = await fetch(`${API}/api/orchestrator/result/${encodeURIComponent(jobId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Result unavailable.");
      setOrchestratorResult(data);
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Result unavailable."}`);
    }
  }

  async function searchProjectMemory() {
    if (!memoryProject) return;
    setMemoryBusy("search");
    setMemoryContext("");

    try {
      const response = await fetch(`${API}/api/memory/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: memoryProject,
          query: memorySearch,
          limit: 30,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Memory search failed.");
      setMemorySearchResults(Array.isArray(data.memories) ? data.memories : []);
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Memory search failed."}`);
    } finally {
      setMemoryBusy("");
    }
  }

  async function previewProjectContext() {
    if (!memoryProject) return;
    setMemoryBusy("context");

    try {
      const response = await fetch(`${API}/api/memory/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: memoryProject,
          query: memorySearch,
          limit: 8,
          max_chars: 12000,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Context preview failed.");
      setMemoryContext(String(data.context || ""));
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Context preview failed."}`);
    } finally {
      setMemoryBusy("");
    }
  }

  async function addProjectMemory() {
    const projectId = (memoryNewProject || memoryProject).trim();
    if (!projectId || !memoryNewText.trim()) {
      setDiagnosticOutput("ERROR: Project ID and memory text are required.");
      return;
    }

    setMemoryBusy("add");
    try {
      const response = await fetch(`${API}/api/memory/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          title: memoryNewTitle.trim(),
          kind: memoryNewKind.trim() || "note",
          source: "control-center",
          tags: memoryNewTags
            .split(",")
            .map(tag => tag.trim())
            .filter(Boolean),
          text: memoryNewText.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Add memory failed.");

      setMemoryProject(projectId);
      setMemoryNewProject("");
      setMemoryNewTitle("");
      setMemoryNewTags("");
      setMemoryNewText("");
      setDiagnosticOutput(
        `${data.created ? "Created" : "Deduplicated"} ${data.memory?.memory_id || "memory"}`
      );

      await refreshMemoryProjects();
      await loadMemoryProject(projectId);
      await refreshRuntime();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Add memory failed."}`);
    } finally {
      setMemoryBusy("");
    }
  }

  async function deleteProjectMemory(memoryId: string) {
    if (!memoryId) return;
    setMemoryBusy(`delete:${memoryId}`);

    try {
      const response = await fetch(`${API}/api/memory/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || "Delete memory failed.");

      setSelectedMemory(null);
      setMemorySearchResults(prev => prev.filter(item => item.memory_id !== memoryId));
      await refreshMemoryProjects();
      await loadMemoryProject(memoryProject);
      await refreshRuntime();
    } catch (err: any) {
      setDiagnosticOutput(`ERROR: ${err?.message || "Delete memory failed."}`);
    } finally {
      setMemoryBusy("");
    }
  }

  async function loadServiceLog(target: string, quiet = false) {
    if (!quiet) setServiceLogLoading(true);
    try {
      const response = await fetch(`${API}/api/service/${encodeURIComponent(target)}/log?lines=140`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Log HTTP ${response.status}`);
      setServiceLog(data);
    } catch (err: any) {
      setServiceLog({
        target,
        label: target,
        lines: 0,
        files: [],
        output: `ERROR: ${err?.message || "Unable to load service log"}`,
      });
    } finally {
      if (!quiet) setServiceLogLoading(false);
    }
  }

  async function startService(service: ServiceState) {
    await postAction(`/api/service/${encodeURIComponent(service.target)}/start`, `start-${service.key}`, 1200);
    await loadServiceLog(service.target, true);
  }

  async function stopService(service: ServiceState) {
    await postAction(`/api/service/${encodeURIComponent(service.target)}/stop`, `stop-${service.key}`, 700);
    await loadServiceLog(service.target, true);
  }

  async function recoverService(service: ServiceState) {
    await postAction(`/api/recovery/${encodeURIComponent(service.target)}`, `recover-${service.key}`, 1200);
    await loadServiceLog(service.target, true);
  }

  const pageTitle = useMemo(() => nav.find(n => n.id === page)?.label ?? "Home", [page]);
  const overall = stack?.overall ?? "offline";
  const serviceStatus = `${stack?.onlineCount ?? 0}/${stack?.total ?? 9}`;
  const activeModel = managerActiveModel(stack);
  const gpu = stack?.gpu;
  const selectedService =
    stack?.services.find(service => service.key === selectedServiceKey) ??
    stack?.services[0] ??
    null;

  useEffect(() => {
    if (!liveConsoleOpen || liveConsolePaused || page === "chat") return;

    void refreshLiveConsole();
    const timer = setInterval(refreshLiveConsole, 1000);
    return () => clearInterval(timer);
  }, [liveConsoleOpen, liveConsolePaused, page]);

  useEffect(() => {
    if (liveConsoleAutoScroll) {
      liveConsoleEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [liveConsoleEvents.length, liveConsoleAutoScroll]);

  useEffect(() => {
    if (page === "services" && selectedService?.target) {
      void loadServiceLog(selectedService.target, true);
    }
  }, [page, selectedServiceKey]);

  useEffect(() => {
    if (page !== "orchestrator") return;

    void refreshOrchestrator();
    const timer = setInterval(refreshOrchestrator, 2000);
    return () => clearInterval(timer);
  }, [page, selectedJobId]);

  useEffect(() => {
    if (page !== "memory") return;
    void refreshMemoryProjects();
  }, [page]);

  useEffect(() => {
    if (page === "memory" && memoryProject) {
      void loadMemoryProject(memoryProject);
    }
  }, [page, memoryProject]);

  const resolvedOrchestratorMode: "fast" | "full" =
    orchestratorWorkflowMode === "auto"
      ? (shouldUseFastWorkflow(orchestratorObjective, orchestratorWorkspace) ? "fast" : "full")
      : orchestratorWorkflowMode;

  const orchestratorDisplayPipeline =
    resolvedOrchestratorMode === "fast"
      ? FAST_WORKFLOW_STAGES
      : orchestratorPipeline;

  const filteredConsoleEvents = liveConsoleEvents.filter(event => {
    if (liveConsoleFilter === "all") return true;
    if (liveConsoleFilter === "errors") return event.kind === "error" || event.level === "error";
    return event.kind === "work";
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <div>
            <div className="brand-name">WCKD</div>
            <div className="brand-sub">CONTROL CENTER</div>
          </div>
        </div>

        <nav>
          {nav.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? "active" : ""}`}
                onClick={() => setPage(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="footer-label">WCKD CORE API</div>
          <Pill online={apiOnline}>{apiOnline ? "Connected" : "Offline"}</Pill>
          <div className="sidebar-stack-state">
            <span>Suite</span>
            <strong className={`stack-${overall}`}>{titleStatus(overall)}</strong>
          </div>
        </div>
      </aside>

      <main className={`main ${liveConsoleOpen && page !== "chat" ? "live-console-open" : ""}`}>
        {page !== "chat" && (
          <header className="topbar">
            <div>
              <h1>{pageTitle}</h1>
              <p>WCKD Suite control plane · v0.9.6</p>
            </div>
            <div className="top-actions">
              <div className="zoom-chip" title="Ctrl +/- · Ctrl+MouseWheel · Ctrl+0 reset">
                <button onClick={() => stepUiZoom(-1)} aria-label="Zoom out">−</button>
                <span>{uiZoom}%</span>
                <button onClick={() => stepUiZoom(1)} aria-label="Zoom in">+</button>
              </div>
              <button
                className={`console-toggle ${liveConsoleOpen ? "active" : ""}`}
                onClick={() => setConsoleOpen(!liveConsoleOpen)}
                title={liveConsoleOpen ? "Hide Live Console" : "Show Live Console"}
              >
                <Terminal size={14}/> Console
              </button>
              <StatusPill status={overall}>{titleStatus(overall)} · {serviceStatus}</StatusPill>
              <Pill online={ollamaOnline}>Ollama {ollamaOnline ? "Online" : "Offline"}</Pill>
              <button className="icon-button" onClick={refreshAll} title="Refresh">
                <RefreshCw size={17} />
              </button>
            </div>
          </header>
        )}

        {page === "home" && (
          <section className="content">
            <div className="hero stack-hero">
              <div>
                <div className="eyebrow">WCKD SUITE CONTROL PLANE</div>
                <h2>{overall === "online" ? "All core systems operational." : overall === "degraded" ? "Suite is running with a degraded dependency." : "WCKD Suite is offline."}</h2>
                <p>Live control for routing, agents, model residency, orchestration, project memory and recovery.</p>
                <div className="hero-actions">
                  <button
                    className="primary"
                    disabled={Boolean(busyAction) || overall === "online"}
                    onClick={() => postAction("/api/suite/start", "start-suite", 1800)}
                  >
                    <Play size={16}/> Start Suite
                  </button>
                  <button
                    className="secondary"
                    disabled={Boolean(busyAction) || overall === "offline"}
                    onClick={() => postAction("/api/suite/stop", "stop-suite", 1400)}
                  >
                    <Square size={16}/> Stop Suite
                  </button>
                  <button
                    className="secondary"
                    disabled={Boolean(busyAction)}
                    onClick={() => postAction("/api/recovery", "recover-all", 1200)}
                  >
                    <ShieldCheck size={16}/> Recover Core
                  </button>
                </div>
              </div>
              <div className={`hero-orb stack-orb ${overall}`}><Activity size={44} /></div>
            </div>

            <div className="stack-stats">
              <div className="stack-stat">
                <span>SERVICES</span>
                <strong>{serviceStatus}</strong>
                <small>{titleStatus(overall)}</small>
              </div>
              <div className="stack-stat">
                <span>ACTIVE MODEL</span>
                <strong className="wide-value">{activeModel}</strong>
                <small>single-active-model policy</small>
              </div>
              <div className="stack-stat">
                <span>GPU VRAM</span>
                <strong>{fmtMemory(gpu?.memoryUsedMB)} / {fmtMemory(gpu?.memoryTotalMB)}</strong>
                <small>{gpu?.temperature !== undefined ? `${gpu.temperature}°C · ${gpu.utilization ?? 0}% GPU` : "NVIDIA telemetry unavailable"}</small>
              </div>
              <div className="stack-stat">
                <span>ORCHESTRATOR</span>
                <strong>{stack?.orchestrator?.activeJobId ? "RUNNING" : "IDLE"}</strong>
                <small>{stack?.orchestrator?.queued ?? 0} queued</small>
              </div>
            </div>

            <div className="section-heading">
              <div>
                <h3>LLM Workspace</h3>
                <p>Local text models, agents and orchestration.</p>
              </div>
            </div>

            <div className="module-grid">
              <ModuleCard title="Chat & Agents" subtitle="LLMs, tools, RAG and agents" status={`${models.length} local models`} icon={MessageSquare} onOpen={() => setPage("chat")} />
            </div>

            <div className="split-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Core Stack</h3>
                    <p>Live health from all WCKD services.</p>
                  </div>
                  <button className="text-button" onClick={() => setPage("services")}>Open Services <ChevronRight size={15}/></button>
                </div>
                <div className="service-mini-grid">
                  {(stack?.services ?? []).map(service => (
                    <div className="service-mini" key={service.key}>
                      <div>
                        <strong>{service.label}{service.optional ? " · OPTIONAL" : ""}</strong>
                        <span>:{service.port}{service.version ? ` · v${service.version}` : ""}</span>
                      </div>
                      <StatusPill status={service.status}>{titleStatus(service.status)}</StatusPill>
                    </div>
                  ))}
                  {!stack && <div className="empty">Waiting for WCKD Core API…</div>}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Intelligence Layer</h3>
                    <p>Registry, orchestration and persistent memory.</p>
                  </div>
                </div>

                <div className="intel-row">
                  <div className="intel-icon"><Workflow size={18}/></div>
                  <div><strong>Specialist Registry</strong><span>{stack?.registry?.count ?? "—"} specialists · {stack?.registry?.valid === false ? "invalid" : "validated"}</span></div>
                </div>
                <div className="intel-row">
                  <div className="intel-icon"><Activity size={18}/></div>
                  <div><strong>Agent Orchestrator</strong><span>{stack?.orchestrator?.activeJobId ? `active ${stack?.orchestrator?.activeJobId}` : "idle"} · {stack?.orchestrator?.queued ?? 0} queued</span></div>
                </div>
                <div className="intel-row">
                  <div className="intel-icon"><Database size={18}/></div>
                  <div><strong>Project Memory</strong><span>{stack?.memory?.projects ?? "—"} projects · {stack?.memory?.memories ?? "—"} memories · {stack?.memory?.retrieval ?? "—"}</span></div>
                </div>

                <div className="button-row">
                  <button className="secondary" disabled={Boolean(busyAction)} onClick={() => postAction("/api/doctor", "doctor", 300)}>
                    <Activity size={16}/> Run Doctor
                  </button>
                  <button className="secondary" onClick={() => setPage("models")}>
                    <Boxes size={16}/> Models
                  </button>
                </div>
              </div>
            </div>

            {diagnosticOutput && (
              <div className="diagnostic-panel">
                <div className="diagnostic-head">
                  <strong>Latest operation</strong>
                  <button className="text-button" onClick={() => setDiagnosticOutput("")}>Clear</button>
                </div>
                <pre>{diagnosticOutput}</pre>
              </div>
            )}
          </section>
        )}

        {page === "chat" && (
          <ChatStudio
            models={models}
            ollamaOnline={ollamaOnline}
            refreshRuntime={refreshRuntime}
          />
        )}

        {page === "models" && (
          <section className="content">
            <div className="section-heading services-heading">
              <div>
                <h3>Model Manager</h3>
                <p>Single-active-model residency, VRAM telemetry and specialist routing map.</p>
              </div>
              <div className="service-actions">
                <button className="secondary" onClick={refreshAll} disabled={Boolean(modelAction)}>
                  <RefreshCw size={15}/> Refresh
                </button>
                <button
                  className="secondary danger-soft"
                  onClick={() => runModelAction("unload")}
                  disabled={Boolean(modelAction) || activeModel === "—"}
                >
                  <Square size={14}/> Unload Active
                </button>
              </div>
            </div>

            <div className="model-runtime-strip">
              <div>
                <span>ACTIVE IN VRAM</span>
                <strong>{activeModel}</strong>
              </div>
              <div>
                <span>POLICY</span>
                <strong>{String(stack?.managerStatus?.policy ?? "single-active-model")}</strong>
              </div>
              <div>
                <span>GPU</span>
                <strong>{gpu?.name ?? "—"}</strong>
              </div>
              <div>
                <span>VRAM</span>
                <strong>{fmtMemory(gpu?.memoryUsedMB)} / {fmtMemory(gpu?.memoryTotalMB)}</strong>
              </div>
            </div>

            <div className="panel model-vram-panel">
              <div className="model-vram-head">
                <div>
                  <small>GPU RESIDENCY</small>
                  <strong>{gpu?.memoryUsedMB !== undefined && gpu?.memoryTotalMB
                    ? `${Math.round((gpu.memoryUsedMB / gpu.memoryTotalMB) * 100)}%`
                    : "—"}</strong>
                </div>
                <span>{fmtMemory(gpu?.memoryUsedMB)} used of {fmtMemory(gpu?.memoryTotalMB)}</span>
              </div>
              <div className="model-vram-track">
                <div
                  className="model-vram-fill"
                  style={{
                    width: `${gpu?.memoryUsedMB !== undefined && gpu?.memoryTotalMB
                      ? Math.min(100, Math.max(0, (gpu.memoryUsedMB / gpu.memoryTotalMB) * 100))
                      : 0}%`,
                  }}
                />
              </div>
              <p>Model Manager keeps one Ollama model resident. Switch unloads the current model before warming the selected model.</p>
            </div>

            <div className="model-list">
              {models.map(model => {
                const isActive = model.name === activeModel;
                const busy = Boolean(modelAction);

                return (
                  <div className={`model-card model-control-card ${isActive ? "active-model-card" : ""}`} key={model.name}>
                    <div className="model-avatar"><Bot size={21}/></div>
                    <div className="model-main">
                      <strong>{model.name}</strong>
                      <span>{model.parameters || "—"} parameters · {model.quantization || "—"} · {model.size}</span>
                    </div>
                    <div className="model-context">
                      <small>MAX CONTEXT</small>
                      <strong>{model.context || "—"}</strong>
                    </div>
                    <div className="model-card-state">
                      {isActive
                        ? <StatusPill status="online">IN VRAM</StatusPill>
                        : <span className="model-cold">COLD</span>}
                    </div>
                    <div className="model-card-actions">
                      {!isActive && activeModel === "—" && (
                        <button
                          className="secondary compact"
                          disabled={busy}
                          onClick={() => runModelAction("load", model.name)}
                        >
                          <Play size={13}/> {modelAction === `load:${model.name}` ? "Loading..." : "Load"}
                        </button>
                      )}
                      {!isActive && activeModel !== "—" && (
                        <button
                          className="secondary compact"
                          disabled={busy}
                          onClick={() => runModelAction("switch", model.name)}
                        >
                          <RefreshCw size={13}/> {modelAction === `switch:${model.name}` ? "Switching..." : "Switch"}
                        </button>
                      )}
                      {isActive && (
                        <button
                          className="secondary compact danger-soft"
                          disabled={busy}
                          onClick={() => runModelAction("unload")}
                        >
                          <Square size={13}/> {modelAction.startsWith("unload") ? "Unloading..." : "Unload"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!models.length && <div className="panel empty">No Ollama models found.</div>}
            </div>

            <div className="panel specialist-map-panel">
              <div className="panel-head">
                <div>
                  <h3>Specialist → Model Map</h3>
                  <p>Live routing profiles from Specialist Registry :8050</p>
                </div>
                <span className="specialist-count">{specialists.length} specialists</span>
              </div>

              <div className="specialist-map-grid">
                {specialists.map(profile => (
                  <div className="specialist-map-row" key={profile.id}>
                    <div>
                      <strong>{profile.id}</strong>
                      <span>{profile.route || "auto route"}{profile.tools ? ` · ${profile.tools}` : ""}</span>
                    </div>
                    <div className="specialist-primary-model">
                      <Bot size={14}/>
                      <strong>{profile.model}</strong>
                    </div>
                    <div className="specialist-fallbacks">
                      <small>FALLBACK</small>
                      <span>{profile.fallback?.length ? profile.fallback.join(" → ") : "—"}</span>
                    </div>
                  </div>
                ))}
                {!specialists.length && <div className="empty">Specialist Registry data unavailable.</div>}
              </div>
            </div>

            {diagnosticOutput && (
              <div className="diagnostic-panel">
                <div className="diagnostic-head">
                  <strong>Model Manager output</strong>
                  <button className="text-button" onClick={() => setDiagnosticOutput("")}>Clear</button>
                </div>
                <pre>{diagnosticOutput}</pre>
              </div>
            )}
          </section>
        )}

        {page === "orchestrator" && (
          <section className="content">
            <div className="section-heading services-heading">
              <div>
                <h3>Agent Orchestrator</h3>
                <p>Queue multi-stage specialist workflows with optional Project Memory context.</p>
              </div>
              <div className="service-actions">
                <button className="secondary" onClick={refreshOrchestrator} disabled={Boolean(orchestratorBusy)}>
                  <RefreshCw size={15}/> Refresh
                </button>
              </div>
            </div>

            <div className="orchestrator-runtime-strip">
              <div>
                <span>STATE</span>
                <strong>{stack?.orchestrator?.activeJobId ? "RUNNING" : "IDLE"}</strong>
              </div>
              <div>
                <span>ACTIVE JOB</span>
                <strong>{stack?.orchestrator?.activeJobId || "—"}</strong>
              </div>
              <div>
                <span>QUEUE</span>
                <strong>{stack?.orchestrator?.queued ?? 0}</strong>
              </div>
              <div>
                <span>MEMORY</span>
                <strong>{stack?.memory?.databaseOk ? "CONNECTED" : "OFFLINE"}</strong>
              </div>
            </div>

            <div className="split-grid orchestrator-create-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Start workflow</h3>
                    <p>Auto uses a fast chat-only path for simple questions and the full agent pipeline for execution work.</p>
                  </div>
                </div>

                <label className="form-label">
                  Objective
                  <textarea
                    className="control-textarea"
                    value={orchestratorObjective}
                    onChange={event => setOrchestratorObjective(event.target.value)}
                    placeholder="Describe the task the orchestrator should complete..."
                  />
                </label>

                <div className="workflow-mode-row">
                  <div>
                    <span>WORKFLOW MODE</span>
                    <strong>
                      {orchestratorWorkflowMode.toUpperCase()}
                      {orchestratorWorkflowMode === "auto" ? ` → ${resolvedOrchestratorMode.toUpperCase()}` : ""}
                    </strong>
                  </div>
                  <div className="workflow-mode-buttons">
                    {(["auto","fast","full"] as WorkflowMode[]).map(mode => (
                      <button
                        key={mode}
                        className={orchestratorWorkflowMode === mode ? "active" : ""}
                        onClick={() => setOrchestratorWorkflowMode(mode)}
                        type="button"
                      >
                        {mode.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="workflow-mode-help">
                  FAST = answer only, no Agent Runner · FULL = plan → execute → review · AUTO = conservative automatic choice.
                </p>

                <div className="form-grid two">
                  <label className="form-label">
                    Workspace
                    <input
                      className="control-input"
                      value={orchestratorWorkspace}
                      onChange={event => setOrchestratorWorkspace(event.target.value)}
                      placeholder="/workspace/... (optional)"
                    />
                  </label>

                  <label className="form-label">
                    Project Memory
                    <select
                      className="control-input"
                      value={orchestratorProject}
                      onChange={event => setOrchestratorProject(event.target.value)}
                    >
                      <option value="">No project memory</option>
                      {memoryProjects.map(project => (
                        <option key={project.project_id} value={project.project_id}>
                          {project.project_id} · {project.memories} memories
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={orchestratorMemoryEnabled}
                      onChange={event => setOrchestratorMemoryEnabled(event.target.checked)}
                    />
                    Use Project Memory context
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={orchestratorSaveMemory}
                      onChange={event => setOrchestratorSaveMemory(event.target.checked)}
                    />
                    Save final result to memory
                  </label>
                </div>

                <button
                  className="primary orchestrator-start"
                  disabled={Boolean(orchestratorBusy) || !orchestratorObjective.trim()}
                  onClick={startOrchestratorJob}
                >
                  <Play size={15}/> {orchestratorBusy === "start" ? "Queueing..." : "Start Workflow"}
                </button>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Resolved pipeline</h3>
                    <p>{resolvedOrchestratorMode === "fast" ? "Fast chat-only path; Agent Runner is bypassed." : "Full specialist pipeline with execution and verification."}</p>
                  </div>
                </div>

                <div className="pipeline-list">
                  {orchestratorDisplayPipeline.map((stage, index) => (
                    <div className="pipeline-stage" key={stage.id || index}>
                      <div className="pipeline-index">{index + 1}</div>
                      <div>
                        <strong>{stage.id || `stage-${index + 1}`}</strong>
                        <span>{String(stage.type || "chat").toUpperCase()} · {stage.specialist || "GENERAL"}</span>
                      </div>
                    </div>
                  ))}
                  {!orchestratorDisplayPipeline.length && <div className="empty">Pipeline unavailable.</div>}
                </div>
              </div>
            </div>

            <div className="orchestrator-workbench">
              <div className="panel orchestrator-jobs-panel">
                <div className="panel-head">
                  <div>
                    <h3>Jobs</h3>
                    <p>Persistent orchestration history.</p>
                  </div>
                  <span className="specialist-count">{orchestratorJobs.length} shown</span>
                </div>

                <div className="orchestrator-job-list">
                  {orchestratorJobs.map(job => {
                    const completed = Number(job.progress?.completed_stages ?? 0);
                    const total = Number(job.progress?.total_stages ?? 0);
                    return (
                      <button
                        key={job.job_id}
                        className={`orchestrator-job ${selectedJobId === job.job_id ? "selected" : ""}`}
                        onClick={() => loadOrchestratorResult(job.job_id)}
                      >
                        <div className="orchestrator-job-top">
                          <strong>{job.job_id}</strong>
                          <span className={`job-status ${job.status}`}>{job.status}</span>
                        </div>
                        <span>{job.current_stage || job.workspace || "—"}</span>
                        <small>{completed}/{total} stages · {job.created || "—"}</small>
                      </button>
                    );
                  })}
                  {!orchestratorJobs.length && <div className="empty">No orchestrator jobs yet.</div>}
                </div>
              </div>

              <div className="panel orchestrator-result-panel">
                <div className="service-inspector-head">
                  <div>
                    <small>JOB RESULT</small>
                    <h3>{orchestratorResult?.job_id || "Select a job"}</h3>
                    <p>{orchestratorResult?.objective || "Choose a job to inspect its stages and result."}</p>
                  </div>
                  {orchestratorResult && !["completed","failed","cancelled","timeout","step_limit","stalled","blocked","interrupted"].includes(orchestratorResult.status) && (
                    <button
                      className="secondary compact danger-soft"
                      disabled={Boolean(orchestratorBusy)}
                      onClick={() => cancelOrchestratorJob(orchestratorResult.job_id)}
                    >
                      <Square size={13}/> Cancel
                    </button>
                  )}
                </div>

                {orchestratorResult && (
                  <>
                    <div className="service-inspector-grid">
                      <div className="meta-kv"><span>Status</span><strong>{orchestratorResult.status}</strong></div>
                      <div className="meta-kv"><span>Workspace</span><strong>{orchestratorResult.workspace || "—"}</strong></div>
                      <div className="meta-kv"><span>Project</span><strong>{orchestratorResult.project_id || "—"}</strong></div>
                      <div className="meta-kv"><span>Memory</span><strong>{orchestratorResult.memory_used ? `${orchestratorResult.memory_citations?.length ?? 0} citations` : "not used"}</strong></div>
                    </div>

                    <div className="stage-result-list">
                      {(orchestratorResult.stage_results ?? []).map((stage, index) => (
                        <div className="stage-result" key={`${stage.id}-${index}`}>
                          <div>
                            <strong>{stage.id || `stage-${index + 1}`}</strong>
                            <span>{stage.specialist || "—"} · {stage.model || "—"} · {stage.duration_seconds ?? "—"}s</span>
                          </div>
                          <span className={`job-status ${stage.status || ""}`}>{stage.status || "—"}</span>
                        </div>
                      ))}
                    </div>

                    <div className="result-block">
                      <strong>Final response</strong>
                      <pre>{orchestratorResult.final_response || orchestratorResult.last_error || "Job has not produced a final response yet."}</pre>
                    </div>

                    {orchestratorResult.saved_memory?.memory_id && (
                      <div className="saved-memory-note">
                        <Database size={14}/>
                        Saved to Project Memory: <strong>{orchestratorResult.saved_memory.memory_id}</strong>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {diagnosticOutput && (
              <div className="diagnostic-panel">
                <div className="diagnostic-head">
                  <strong>Orchestrator output</strong>
                  <button className="text-button" onClick={() => setDiagnosticOutput("")}>Clear</button>
                </div>
                <pre>{diagnosticOutput}</pre>
              </div>
            )}
          </section>
        )}

        {page === "memory" && (
          <section className="content">
            <div className="section-heading services-heading">
              <div>
                <h3>Project Memory</h3>
                <p>Project-scoped persistent notes, RAG search and context preview.</p>
              </div>
              <div className="service-actions">
                <button className="secondary" onClick={refreshMemoryProjects} disabled={Boolean(memoryBusy)}>
                  <RefreshCw size={15}/> Refresh
                </button>
              </div>
            </div>

            <div className="memory-runtime-strip">
              <div>
                <span>BACKEND</span>
                <strong>SQLite</strong>
              </div>
              <div>
                <span>RETRIEVAL</span>
                <strong>{stack?.memory?.retrieval || "—"}</strong>
              </div>
              <div>
                <span>PROJECTS</span>
                <strong>{stack?.memory?.projects ?? 0}</strong>
              </div>
              <div>
                <span>MEMORIES</span>
                <strong>{stack?.memory?.memories ?? 0}</strong>
              </div>
            </div>

            <div className="split-grid memory-top-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Project browser</h3>
                    <p>Select a project to inspect its persistent memory.</p>
                  </div>
                </div>

                <label className="form-label">
                  Project
                  <select
                    className="control-input"
                    value={memoryProject}
                    onChange={event => {
                      setMemoryProject(event.target.value);
                      setSelectedMemory(null);
                      setMemorySearchResults([]);
                      setMemoryContext("");
                    }}
                  >
                    <option value="">Select project</option>
                    {memoryProjects.map(project => (
                      <option key={project.project_id} value={project.project_id}>
                        {project.project_id} · {project.memories} memories
                      </option>
                    ))}
                  </select>
                </label>

                <div className="memory-project-list">
                  {memoryProjects.map(project => (
                    <button
                      className={`memory-project-row ${memoryProject === project.project_id ? "selected" : ""}`}
                      key={project.project_id}
                      onClick={() => setMemoryProject(project.project_id)}
                    >
                      <div>
                        <strong>{project.project_id}</strong>
                        <span>{project.updated_at || "—"}</span>
                      </div>
                      <b>{project.memories}</b>
                    </button>
                  ))}
                  {!memoryProjects.length && <div className="empty">No memory projects yet.</div>}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Add memory</h3>
                    <p>Create a note or start a new project.</p>
                  </div>
                </div>

                <div className="form-grid two">
                  <label className="form-label">
                    Project ID
                    <input
                      className="control-input"
                      value={memoryNewProject}
                      onChange={event => setMemoryNewProject(event.target.value)}
                      placeholder={memoryProject || "project-id"}
                    />
                  </label>
                  <label className="form-label">
                    Kind
                    <input
                      className="control-input"
                      value={memoryNewKind}
                      onChange={event => setMemoryNewKind(event.target.value)}
                      placeholder="note"
                    />
                  </label>
                </div>

                <label className="form-label">
                  Title
                  <input
                    className="control-input"
                    value={memoryNewTitle}
                    onChange={event => setMemoryNewTitle(event.target.value)}
                    placeholder="Optional title"
                  />
                </label>

                <label className="form-label">
                  Tags
                  <input
                    className="control-input"
                    value={memoryNewTags}
                    onChange={event => setMemoryNewTags(event.target.value)}
                    placeholder="comma,separated,tags"
                  />
                </label>

                <label className="form-label">
                  Memory text
                  <textarea
                    className="control-textarea memory-textarea"
                    value={memoryNewText}
                    onChange={event => setMemoryNewText(event.target.value)}
                    placeholder="Persistent project information..."
                  />
                </label>

                <button
                  className="primary"
                  disabled={Boolean(memoryBusy) || !(memoryNewProject || memoryProject).trim() || !memoryNewText.trim()}
                  onClick={addProjectMemory}
                >
                  <Plus size={15}/> {memoryBusy === "add" ? "Saving..." : "Add Memory"}
                </button>
              </div>
            </div>

            <div className="panel memory-search-panel">
              <div className="memory-search-row">
                <input
                  className="control-input"
                  value={memorySearch}
                  onChange={event => setMemorySearch(event.target.value)}
                  placeholder="Search the selected project..."
                  onKeyDown={event => {
                    if (event.key === "Enter") void searchProjectMemory();
                  }}
                />
                <button className="secondary" disabled={!memoryProject || Boolean(memoryBusy)} onClick={searchProjectMemory}>
                  <Brain size={14}/> Search
                </button>
                <button className="secondary" disabled={!memoryProject || Boolean(memoryBusy)} onClick={previewProjectContext}>
                  <Database size={14}/> Build Context
                </button>
              </div>
            </div>

            <div className="memory-workbench">
              <div className="panel memory-list-panel">
                <div className="panel-head">
                  <div>
                    <h3>{memorySearchResults.length ? "Search results" : "Project memories"}</h3>
                    <p>{memoryProject || "No project selected"}</p>
                  </div>
                  <span className="specialist-count">{(memorySearchResults.length ? memorySearchResults : memoryItems).length} shown</span>
                </div>

                <div className="memory-item-list">
                  {(memorySearchResults.length ? memorySearchResults : memoryItems).map(item => (
                    <button
                      className={`memory-item-row ${selectedMemory?.memory_id === item.memory_id ? "selected" : ""}`}
                      key={item.memory_id}
                      onClick={() => setSelectedMemory(item)}
                    >
                      <div className="memory-item-head">
                        <strong>{item.title || item.memory_id}</strong>
                        <span>{item.kind || "note"}</span>
                      </div>
                      <p>{item.text}</p>
                      <small>{item.source || "—"} · {item.updated_at || item.created_at || "—"}</small>
                    </button>
                  ))}
                  {memoryProject && !(memorySearchResults.length ? memorySearchResults : memoryItems).length && (
                    <div className="empty">No memories found.</div>
                  )}
                </div>
              </div>

              <div className="panel memory-detail-panel">
                <div className="service-inspector-head">
                  <div>
                    <small>MEMORY DETAIL</small>
                    <h3>{selectedMemory?.title || selectedMemory?.memory_id || "Select a memory"}</h3>
                    <p>{selectedMemory ? `${selectedMemory.kind || "note"} · ${selectedMemory.source || "—"}` : "Choose an item from the list."}</p>
                  </div>
                  {selectedMemory && (
                    <button
                      className="secondary compact danger-soft"
                      disabled={Boolean(memoryBusy)}
                      onClick={() => deleteProjectMemory(selectedMemory.memory_id)}
                    >
                      <Trash2 size={13}/> Delete
                    </button>
                  )}
                </div>

                {selectedMemory && (
                  <>
                    <div className="memory-tags">
                      {(selectedMemory.tags ?? []).map(tag => <span key={tag}>{tag}</span>)}
                    </div>
                    <pre className="memory-detail-text">{selectedMemory.text}</pre>
                    <div className="meta-kv"><span>ID</span><strong>{selectedMemory.memory_id}</strong></div>
                    <div className="meta-kv"><span>Project</span><strong>{selectedMemory.project_id}</strong></div>
                    <div className="meta-kv"><span>Updated</span><strong>{selectedMemory.updated_at || "—"}</strong></div>
                  </>
                )}

                {memoryContext && (
                  <div className="result-block memory-context-block">
                    <strong>RAG context preview</strong>
                    <pre>{memoryContext}</pre>
                  </div>
                )}
              </div>
            </div>

            {diagnosticOutput && (
              <div className="diagnostic-panel">
                <div className="diagnostic-head">
                  <strong>Project Memory output</strong>
                  <button className="text-button" onClick={() => setDiagnosticOutput("")}>Clear</button>
                </div>
                <pre>{diagnosticOutput}</pre>
              </div>
            )}
          </section>
        )}


        {page === "services" && (
          <section className="content">
            <div className="section-heading services-heading">
              <div>
                <h3>WCKD Suite Services</h3>
                <p>Start, stop, recover and inspect logs for the 9-service WCKD Core plus optional services.</p>
              </div>
              <div className="service-actions">
                <button className="primary" disabled={Boolean(busyAction) || overall === "online"} onClick={() => postAction("/api/suite/start", "start-suite", 1800)}>
                  <Play size={15}/> Start Suite
                </button>
                <button className="secondary" disabled={Boolean(busyAction) || overall === "offline"} onClick={() => postAction("/api/suite/stop", "stop-suite", 1400)}>
                  <Square size={15}/> Stop Suite
                </button>
                <button className="secondary" disabled={Boolean(busyAction)} onClick={() => postAction("/api/doctor", "doctor", 300)}>
                  <Activity size={15}/> Doctor
                </button>
                <button className="secondary" disabled={Boolean(busyAction)} onClick={() => postAction("/api/recovery", "recover-all", 1200)}>
                  <ShieldCheck size={15}/> Recover Core
                </button>
              </div>
            </div>

            <div className="panel service-stack-panel">
              {(stack?.services ?? []).map(service => (
                <div
                  className={`service-row stack-service-row ${selectedServiceKey === service.key ? "selected" : ""}`}
                  key={service.key}
                >
                  <div className="service-glyph">
                    {service.key === "memory" ? <Database size={18}/> :
                     service.key === "orchestrator" ? <Workflow size={18}/> :
                     service.key === "manager" ? <Cpu size={18}/> :
                     service.key === "ollama" ? <Bot size={18}/> :
                     <Server size={18}/>}
                  </div>
                  <button
                    className="service-copy service-select"
                    onClick={() => {
                      setSelectedServiceKey(service.key);
                      void loadServiceLog(service.target);
                    }}
                    title={`Inspect ${service.label}`}
                  >
                    <h3>{service.label}{service.optional ? " · OPTIONAL" : ""}</h3>
                    <p>127.0.0.1:{service.port}{service.version ? ` · v${service.version}` : ""}{service.detail ? ` · ${service.detail}` : ""}</p>
                  </button>
                  <StatusPill status={service.status}>{titleStatus(service.status)}</StatusPill>
                  <div className="service-row-actions">
                    <button
                      className="secondary compact"
                      disabled={Boolean(busyAction) || service.online}
                      onClick={() => startService(service)}
                    >
                      <Play size={13}/> Start
                    </button>
                    <button
                      className="secondary compact danger-soft"
                      disabled={Boolean(busyAction) || !service.online}
                      onClick={() => stopService(service)}
                    >
                      <Square size={13}/> Stop
                    </button>
                    <button
                      className="secondary compact"
                      disabled={Boolean(busyAction)}
                      onClick={() => recoverService(service)}
                    >
                      <RefreshCw size={13}/> Recover
                    </button>
                  </div>
                </div>
              ))}
              {!stack && <div className="empty">WCKD Core API is not returning stack health.</div>}
            </div>

            <div className="panel service-inspector">
              <div className="service-inspector-head">
                <div>
                  <small>SERVICE INSPECTOR</small>
                  <h3>{selectedService?.label ?? "Select a service"}</h3>
                  <p>
                    {selectedService
                      ? `127.0.0.1:${selectedService.port}${selectedService.version ? ` · v${selectedService.version}` : ""}`
                      : "Select a service from the stack above."}
                  </p>
                </div>
                <div className="service-actions">
                  {selectedService && (
                    <>
                      <button
                        className="secondary compact"
                        disabled={Boolean(busyAction) || selectedService.online}
                        onClick={() => startService(selectedService)}
                      >
                        <Play size={13}/> Start
                      </button>
                      <button
                        className="secondary compact danger-soft"
                        disabled={Boolean(busyAction) || !selectedService.online}
                        onClick={() => stopService(selectedService)}
                      >
                        <Square size={13}/> Stop
                      </button>
                      <button
                        className="secondary compact"
                        disabled={Boolean(busyAction)}
                        onClick={() => recoverService(selectedService)}
                      >
                        <RefreshCw size={13}/> Recover
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="service-inspector-grid">
                <div className="meta-kv"><span>Status</span><strong>{selectedService ? titleStatus(selectedService.status) : "—"}</strong></div>
                <div className="meta-kv"><span>Recovery target</span><strong>{selectedService?.target ?? "—"}</strong></div>
                <div className="meta-kv"><span>Detail</span><strong>{selectedService?.detail || "—"}</strong></div>
                <div className="meta-kv"><span>Control</span><strong>manual · per-service</strong></div>
              </div>

              <div className="service-log-toolbar">
                <div>
                  <strong>Recent service log</strong>
                  <span>{serviceLog?.files?.length ? serviceLog.files.join(" · ") : "stdout / stderr when available"}</span>
                </div>
                <button
                  className="secondary compact"
                  disabled={!selectedService || serviceLogLoading}
                  onClick={() => selectedService && loadServiceLog(selectedService.target)}
                >
                  <RefreshCw size={13}/> {serviceLogLoading ? "Loading..." : "Refresh Log"}
                </button>
              </div>

              <pre className="service-log">
                {serviceLogLoading
                  ? "Loading recent log lines..."
                  : serviceLog?.output || "No log output available yet."}
              </pre>

              <p className="service-control-note">
                Stopping a dependency can intentionally put WCKD Suite into DEGRADED state. Recover uses the existing dependency-aware AutoRecovery logic. Windows autostart remains unchanged.
              </p>
            </div>

            <div className="split-grid service-meta-grid">
              <div className="panel">
                <div className="panel-head"><div><h3>GPU</h3><p>Live NVIDIA telemetry</p></div></div>
                <div className="meta-kv"><span>Name</span><strong>{gpu?.name ?? "—"}</strong></div>
                <div className="meta-kv"><span>VRAM</span><strong>{fmtMemory(gpu?.memoryUsedMB)} / {fmtMemory(gpu?.memoryTotalMB)}</strong></div>
                <div className="meta-kv"><span>Utilization</span><strong>{gpu?.utilization !== undefined ? `${gpu.utilization}%` : "—"}</strong></div>
                <div className="meta-kv"><span>Temperature</span><strong>{gpu?.temperature !== undefined ? `${gpu.temperature}°C` : "—"}</strong></div>
              </div>
              <div className="panel">
                <div className="panel-head"><div><h3>Core policies</h3><p>Current WCKD runtime state</p></div></div>
                <div className="meta-kv"><span>Model policy</span><strong>{String(stack?.managerStatus?.policy ?? "single-active-model")}</strong></div>
                <div className="meta-kv"><span>Active model</span><strong>{activeModel}</strong></div>
                <div className="meta-kv"><span>Specialists</span><strong>{stack?.registry?.count ?? "—"}</strong></div>
                <div className="meta-kv"><span>Memory retrieval</span><strong>{stack?.memory?.retrieval ?? "—"}</strong></div>
              </div>
            </div>

            {diagnosticOutput && (
              <div className="diagnostic-panel">
                <div className="diagnostic-head">
                  <strong>Doctor / Recovery / Service output</strong>
                  <button className="text-button" onClick={() => setDiagnosticOutput("")}>Clear</button>
                </div>
                <pre>{diagnosticOutput}</pre>
              </div>
            )}
          </section>
        )}

        {page === "settings" && (
          <section className="content">
            <div className="split-grid settings-grid">
              <div className="panel settings-core">
                <div className="placeholder-icon"><Settings size={28}/></div>
                <h2>Core behavior is intentionally conservative.</h2>
                <p>WCKD Suite remains manual-start. Control Center v0.7.2 adds a persistent real-time WCKD Live Console while preserving Orchestrator, Project Memory and Model Manager behavior without enabling Windows startup or changing service configuration.</p>
              </div>

              <div className="panel zoom-settings-panel">
                <div className="panel-head">
                  <div>
                    <h3>Interface Zoom</h3>
                    <p>Persistent UI scaling for the entire Control Center.</p>
                  </div>
                  <strong className="zoom-value">{uiZoom}%</strong>
                </div>

                <div className="zoom-settings-controls">
                  <button className="secondary" onClick={() => stepUiZoom(-1)} disabled={uiZoom <= UI_ZOOM_MIN}>
                    − Zoom Out
                  </button>
                  <button className="secondary" onClick={() => applyUiZoom(100)}>
                    <RotateCcw size={14}/> 100%
                  </button>
                  <button className="secondary" onClick={() => stepUiZoom(1)} disabled={uiZoom >= UI_ZOOM_MAX}>
                    + Zoom In
                  </button>
                </div>

                <div className="zoom-shortcuts">
                  <span><kbd>Ctrl</kbd> <kbd>+</kbd> zoom in</span>
                  <span><kbd>Ctrl</kbd> <kbd>−</kbd> zoom out</span>
                  <span><kbd>Ctrl</kbd> + mouse wheel</span>
                  <span><kbd>Ctrl</kbd> <kbd>0</kbd> reset</span>
                </div>

                <p className="zoom-range">Range {UI_ZOOM_MIN}%–{UI_ZOOM_MAX}% · step {UI_ZOOM_STEP}% · saved automatically.</p>
              </div>
            </div>
          </section>
        )}

        {liveConsoleOpen && page !== "chat" && (
          <aside className="live-console">
            <div className="live-console-header">
              <div>
                <div className="live-console-title">
                  <Terminal size={15}/>
                  <strong>WCKD LIVE CONSOLE</strong>
                  <span className={`console-live-state ${liveConsolePaused ? "paused" : "live"}`}>
                    {liveConsolePaused ? "PAUSED" : "LIVE"}
                  </span>
                </div>
                <p>Agent · Orchestrator · Model · service events</p>
              </div>
              <button
                className="console-icon-button"
                onClick={() => setConsoleOpen(false)}
                title="Close console"
              >
                <PanelLeftClose size={15}/>
              </button>
            </div>

            <div className="live-console-runtime">
              <div>
                <span>ORCH</span>
                <strong>{liveConsoleMeta?.orchestrator?.stage || liveConsoleMeta?.orchestrator?.status || "IDLE"}</strong>
                <small>{liveConsoleMeta?.orchestrator?.progress || "—"}</small>
              </div>
              <div>
                <span>AGENT</span>
                <strong>{liveConsoleMeta?.runner?.activity || liveConsoleMeta?.runner?.status || "IDLE"}</strong>
                <small>
                  {liveConsoleMeta?.runner?.step != null
                    ? `${liveConsoleMeta.runner.step}/${liveConsoleMeta.runner.max_steps ?? "?"}`
                    : "—"}
                </small>
              </div>
              <div>
                <span>MODEL</span>
                <strong>{liveConsoleMeta?.runner?.model || liveConsoleMeta?.model?.active_model || liveConsoleMeta?.model?.state_model || "—"}</strong>
                <small>single-active</small>
              </div>
            </div>

            <div className="live-console-toolbar">
              <div className="console-filter-group">
                {(["all","work","errors"] as const).map(filter => (
                  <button
                    key={filter}
                    className={liveConsoleFilter === filter ? "active" : ""}
                    onClick={() => setLiveConsoleFilter(filter)}
                  >
                    {filter.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="console-tool-group">
                <button
                  className={liveConsolePaused ? "active" : ""}
                  onClick={() => setLiveConsolePaused(!liveConsolePaused)}
                  title={liveConsolePaused ? "Resume" : "Pause"}
                >
                  {liveConsolePaused ? <Play size={12}/> : <Square size={11}/>}
                </button>
                <button
                  className={liveConsoleAutoScroll ? "active" : ""}
                  onClick={() => setLiveConsoleAutoScroll(!liveConsoleAutoScroll)}
                  title="Auto-scroll"
                >
                  AUTO
                </button>
                <button onClick={copyLiveConsole} title="Copy visible console">
                  <Copy size={12}/>
                </button>
                <button onClick={clearLiveConsole} title="Clear visible buffer">
                  <Trash2 size={12}/>
                </button>
              </div>
            </div>

            <div className="live-console-body">
              {filteredConsoleEvents.length === 0 && (
                <div className="live-console-empty">
                  {liveConsolePaused ? "Console paused." : "Waiting for WCKD activity…"}
                </div>
              )}

              {filteredConsoleEvents.map(event => (
                <div
                  key={event.id}
                  className={`console-event level-${event.level} kind-${event.kind}`}
                  title={event.data ? JSON.stringify(event.data, null, 2) : event.text}
                >
                  <span className="console-time">
                    {event.ts ? new Date(event.ts).toLocaleTimeString([], { hour12: false }) : "--:--:--"}
                  </span>
                  <span className={`console-source source-${event.source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
                    {event.source}
                  </span>
                  <span className="console-event-name">{event.event}</span>
                  <span className="console-event-text">{event.text}</span>
                </div>
              ))}
              <div ref={liveConsoleEndRef}/>
            </div>

            <div className="live-console-footer">
              <span>{filteredConsoleEvents.length}/{liveConsoleEvents.length} events</span>
              <span>poll 1s · buffer {LIVE_CONSOLE_MAX_EVENTS}</span>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}

function ChatStudio({
  models,
  ollamaOnline,
  refreshRuntime,
}: {
  models: OllamaModel[];
  ollamaOnline: boolean;
  refreshRuntime: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(CHAT_STORE) || "[]");
    } catch {
      return [];
    }
  });

  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(ACTIVE_CHAT_STORE) || "");
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState("");
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [chatMemoryProjects, setChatMemoryProjects] = useState<Array<{ project_id: string; memories?: number }>>([]);
  const [chatActivityOpen, setChatActivityOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(CHAT_ACTIVITY_STORE);
    return saved === null ? true : saved === "1";
  });
  const [chatActivityPaused, setChatActivityPaused] = useState(false);
  const [chatActivityEvents, setChatActivityEvents] = useState<LiveConsoleEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatActivityEndRef = useRef<HTMLDivElement | null>(null);
  const chatActivitySeenRef = useRef<Set<string>>(new Set());

  const fallbackModel = WCKD_AUTO_MODEL;
  const active = sessions.find(s => s.id === activeId) || null;

  useEffect(() => {
    if (!active && models.length) {
      const s = makeSession(fallbackModel);
      setSessions(prev => [s, ...prev]);
      setActiveId(s.id);
    }
  }, [models.length]);

  useEffect(() => {
    let cancelled = false;

    async function loadChatMemoryProjects() {
      try {
        const response = await fetch(`${API}/api/memory/projects`);
        const data = await response.json();
        if (!cancelled && response.ok && Array.isArray(data.projects)) {
          setChatMemoryProjects(data.projects);
        }
      } catch {
        // Project Memory remains optional for chat.
      }
    }

    void loadChatMemoryProjects();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      const persistentSessions = sessions.map(session => ({
        ...session,
        messages: session.messages.map(message => ({
          ...message,
          attachments: message.attachments?.map(attachment => ({ ...attachment })),
        })),
      }));

      localStorage.setItem(CHAT_STORE, JSON.stringify(persistentSessions));
    } catch {
      // Chat remains usable even if browser storage reaches its quota.
    }
  }, [sessions]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_CHAT_STORE, activeId);
    setPendingAttachments([]);
    setDragActive(false);

    chatActivitySeenRef.current.clear();
    setChatActivityEvents([]);
    setChatActivityPaused(false);
  }, [activeId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages, generating]);

  function setChatActivityOpenPersisted(next: boolean) {
    setChatActivityOpen(next);
    localStorage.setItem(CHAT_ACTIVITY_STORE, next ? "1" : "0");
  }

  function ensureChatActivityVisible() {
    setChatActivityPaused(false);
    setChatActivityOpenPersisted(true);
  }

  async function refreshChatActivity() {
    if (!chatActivityOpen || chatActivityPaused || !activeId) return;

    try {
      const response = await fetch(
        `${API}/api/chat/activity/${encodeURIComponent(activeId)}?limit=2000`
      );
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.events)) return;

      const fresh: LiveConsoleEvent[] = [];

      for (const event of data.events as LiveConsoleEvent[]) {
        if (!event?.id || chatActivitySeenRef.current.has(event.id)) continue;
        chatActivitySeenRef.current.add(event.id);
        fresh.push(event);
      }

      if (fresh.length) {
        setChatActivityEvents(current =>
          [...current, ...fresh]
            .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
            .slice(-2000)
        );
      }
    } catch {
      // Chat remains usable if the session activity endpoint is unavailable.
    }
  }

  useEffect(() => {
    if (!chatActivityOpen || chatActivityPaused || !activeId) return;

    void refreshChatActivity();
    const timer = setInterval(refreshChatActivity, 750);
    return () => clearInterval(timer);
  }, [chatActivityOpen, chatActivityPaused, activeId]);

  useEffect(() => {
    chatActivityEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatActivityEvents.length]);

  function makeSession(model: string): ChatSession {
    const p = profileDefaults("balanced");
    const level = model !== WCKD_AUTO_MODEL && supportsThinking(model) ? p.thinkingLevel : "off";
    return {
      id: uid(),
      title: "New chat",
      model,
      context: p.context,
      thinking: level !== "off",
      thinkingLevel: level,
      profile: "balanced",
      temperature: p.temperature,
      topP: p.topP,
      systemPrompt: "",
      projectId: "",
      memoryEnabled: true,
      saveResultToMemory: true,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function newChat() {
    const s = makeSession(fallbackModel);
    setSessions(prev => [s, ...prev]);
    setActiveId(s.id);
    setInput("");
    setPendingAttachments([]);
    setStats(null);
  }

  function updateActive(patch: Partial<ChatSession>) {
    setSessions(prev => prev.map(s => s.id === activeId ? { ...s, ...patch, updatedAt: Date.now() } : s));
  }


  function applyProfile(profile: "fast" | "balanced" | "deep") {
    const current = active;
    if (!current) return;
    const p = profileDefaults(profile);
    let level: "off" | "low" | "medium" | "high" = supportsThinking(current.model) ? p.thinkingLevel : "off";
    const allowed = thinkingChoices(current.model) as readonly string[];
    if (!allowed.includes(level)) level = allowed.includes("medium") ? "medium" : "off";
    updateActive({
      profile,
      context: p.context,
      temperature: p.temperature,
      topP: p.topP,
      thinkingLevel: level,
      thinking: level !== "off",
    });
  }

async function addAttachmentFiles(files: File[]) {
    if (generating || !files.length) return;

    const remainingSlots = CHAT_MAX_ATTACHMENTS - pendingAttachments.length;
    if (remainingSlots <= 0) {
      alert(`Maximum ${CHAT_MAX_ATTACHMENTS} attachments per message.`);
      return;
    }

    const selected = files.slice(0, remainingSlots);
    const existingBytes = pendingAttachments.reduce((sum, item) => sum + item.size, 0);
    const additions: ChatAttachment[] = [];
    let runningBytes = existingBytes;
    const rejected: string[] = [];

    for (const file of selected) {
      if (runningBytes + file.size > CHAT_MAX_TOTAL_ATTACHMENT_BYTES) {
        rejected.push(`${file.name}: total attachment limit is 6 MB`);
        continue;
      }

if (isSupportedTextFile(file)) {
        try {
          const slice = file.slice(0, CHAT_MAX_TEXT_BYTES);
          const fileText = await slice.text();
          additions.push({
            id: uid(),
            name: file.name,
            kind: "text",
            mime: file.type || "text/plain",
            size: file.size,
            text: fileText,
            truncated: file.size > CHAT_MAX_TEXT_BYTES,
          });
          runningBytes += Math.min(file.size, CHAT_MAX_TEXT_BYTES);
        } catch {
          rejected.push(`${file.name}: could not read text`);
        }
        continue;
      }

      rejected.push(
        `${file.name}: unsupported in v0.8.2 (PDF/DOCX/XLSX parser not installed yet)`
      );
    }

    if (additions.length) {
      setPendingAttachments(current => [...current, ...additions].slice(0, CHAT_MAX_ATTACHMENTS));
    }

if (rejected.length) {
      alert(`Some attachments were not added:\\n\\n${rejected.join("\\n")}`);
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments(current => current.filter(item => item.id !== id));
  }

  async function retryAssistant(messageId: string) {
    const current = active;
    if (!current || generating) return;
    const idx = current.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;

    const prior = current.messages.slice(0, idx);
    const lastUserIndex = [...prior].map(m => m.role).lastIndexOf("user");
    if (lastUserIndex < 0) return;

    const cleanMessages = prior.slice(0, lastUserIndex + 1);
    setSessions(prev => prev.map(s => s.id === current.id ? {
      ...s,
      messages: cleanMessages,
      updatedAt: Date.now(),
    } : s));

    await new Promise(r => setTimeout(r, 0));
    await sendFromMessages(cleanMessages);
  }

  function deleteSession(id: string) {
    const remaining = sessions.filter(s => s.id !== id);
    setSessions(remaining);
    if (activeId === id) {
      if (remaining.length) setActiveId(remaining[0].id);
      else {
        const s = makeSession(fallbackModel);
        setSessions([s]);
        setActiveId(s.id);
      }
    }
  }

  async function ensureOllama() {
    if (ollamaOnline) return true;
    try {
      await fetch(`${API}/api/ollama/start`, { method: "POST" });
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const h = await fetch(`${API}/api/health`).then(r => r.json());
        if (h.ollama) {
          await refreshRuntime();
          return true;
        }
      }
    } catch {}
    return false;
  }

  async function sendFromMessages(baseMessages: ChatMessage[]) {
    if (!active || generating || !active.model) return;

    const ok = await ensureOllama();
    if (!ok) {
      alert("Ollama could not be started.");
      return;
    }

    const assistantId = uid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      thinking: "",
      createdAt: Date.now(),
    };
    const nextMessages = [...baseMessages, assistantMsg];

    setSessions(prev => prev.map(s => s.id === active.id ? {
      ...s,
      messages: nextMessages,
      updatedAt: Date.now()
    } : s));

    setGenerating(true);
    setStats(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const payloadMessages = [
        ...(active.systemPrompt?.trim()
          ? [{ role: "system", content: active.systemPrompt.trim() }]
          : []),
        ...baseMessages.map(ollamaChatMessage),
      ];

      const autoMode = active.model === WCKD_AUTO_MODEL;
      const endpoint = autoMode ? `${API}/api/wckd-auto` : `${API}/api/chat`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: active.model,
          sessionId: active.id,
          context: active.context,
          think: active.thinkingLevel || (active.thinking ? "medium" : "off"),
          temperature: active.temperature ?? 0.55,
          topP: active.topP ?? 0.95,
          projectId: active.projectId || "",
          memoryEnabled: active.memoryEnabled !== false,
          saveResultToMemory: active.saveResultToMemory !== false,
          messages: autoMode
            ? [
                ...(active.systemPrompt?.trim()
                  ? [{ role: "system", content: active.systemPrompt.trim() }]
                  : []),
                ...baseMessages.map(wckdAutoChatMessage),
              ]
            : payloadMessages,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let thinkingText = "";
      let executionEvidence: ExecutionEvidence | undefined;
      let finalStats: RunStats | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          let chunk: any;
          try { chunk = JSON.parse(line); } catch { continue; }

          if (chunk.error) throw new Error(chunk.error);

          if (chunk.message?.thinking) thinkingText += chunk.message.thinking;
          if (chunk.message?.content) assistantText += chunk.message.content;
          if (chunk.execution && typeof chunk.execution === "object") {
            executionEvidence = chunk.execution as ExecutionEvidence;
          }

          if (chunk.done) {
            const evalSeconds = (chunk.eval_duration || 0) / 1e9;
            const promptSeconds = (chunk.prompt_eval_duration || 0) / 1e9;
            finalStats = {
              promptTokens: chunk.prompt_eval_count,
              outputTokens: chunk.eval_count,
              generationTokS: evalSeconds > 0 ? chunk.eval_count / evalSeconds : undefined,
              promptTokS: promptSeconds > 0 ? chunk.prompt_eval_count / promptSeconds : undefined,
              totalSeconds: chunk.total_duration ? chunk.total_duration / 1e9 : undefined,
            };
          }

          setSessions(prev => prev.map(s => s.id === active.id ? {
            ...s,
            messages: s.messages.map(m => m.id === assistantId ? {
              ...m,
              content: assistantText,
              thinking: thinkingText,
              execution: executionEvidence,
            } : m),
            updatedAt: Date.now(),
          } : s));
        }
      }

      setStats(finalStats);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setSessions(prev => prev.map(s => s.id === active.id ? {
          ...s,
          messages: s.messages.map(m => m.id === assistantId ? {
            ...m,
            content: `Error: ${err?.message || "Chat request failed."}`,
          } : m),
        } : s));
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  async function send() {
    if (
      !active ||
      (!input.trim() && pendingAttachments.length === 0) ||
      generating ||
      !active.model
    ) return;

    ensureChatActivityVisible();

    const content = input.trim() || "Analyze the attached file(s).";

    const attachments = pendingAttachments.map(item => ({ ...item }));
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content,
      attachments,
      createdAt: Date.now(),
    };
    const baseMessages = [...active.messages, userMsg];

    const titleSource = input.trim() || attachments[0]?.name || "Attachment";
    const newTitle = active.messages.length === 0
      ? titleSource.replace(/\s+/g, " ").slice(0, 42)
      : active.title;

    setSessions(prev => prev.map(s => s.id === active.id ? {
      ...s,
      title: newTitle,
      messages: baseMessages,
      updatedAt: Date.now()
    } : s));

    setInput("");
    setPendingAttachments([]);
    await new Promise(r => setTimeout(r, 0));
    await sendFromMessages(baseMessages);
  }

  function stop() {
    abortRef.current?.abort();
    setGenerating(false);
  }

  async function copyMessage(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(""), 1200);
  }

  if (!active) {
    return <div className="chat-loading">Loading chat…</div>;
  }

  return (
    <section className={`chat-layout ${historyCollapsed ? "history-collapsed" : ""}`}>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-top">
          {!historyCollapsed && <button className="new-chat-button" onClick={newChat}><Plus size={16}/> New Chat</button>}
          <button className="collapse-history" onClick={() => setHistoryCollapsed(!historyCollapsed)} title={historyCollapsed ? "Show history" : "Hide history"}>
            {historyCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}
          </button>
        </div>
        {!historyCollapsed && <div className="chat-history-label">RECENT</div>}
        {!historyCollapsed && <div className="chat-history">
          {sessions
            .slice()
            .sort((a,b) => b.updatedAt - a.updatedAt)
            .map(s => (
              <div key={s.id} className={`chat-history-item ${s.id === active.id ? "active" : ""}`}>
                <button className="history-main" onClick={() => setActiveId(s.id)}>
                  <MessageSquare size={14}/>
                  <span>{s.title}</span>
                </button>
                <button className="history-delete" onClick={() => deleteSession(s.id)} title="Delete">
                  <Trash2 size={13}/>
                </button>
              </div>
            ))}
        </div>}
      </aside>

      <div
        className={`chat-main ${dragActive ? "drag-active" : ""}`}
        onDragEnter={event => {
          event.preventDefault();
          if (!generating) setDragActive(true);
        }}
        onDragOver={event => {
          event.preventDefault();
          if (!generating) setDragActive(true);
        }}
        onDragLeave={event => {
          if (event.currentTarget === event.target) setDragActive(false);
        }}
        onDrop={event => {
          event.preventDefault();
          setDragActive(false);
          void addAttachmentFiles(Array.from(event.dataTransfer.files || []));
        }}
      >
        {dragActive && (
          <div className="chat-drop-overlay">
            <Paperclip size={24}/>
            <strong>Drop images or text/code files here</strong>
            <span>PNG · JPG · WebP · TXT · MD · JSON · CSV · code · GDScript</span>
          </div>
        )}

        <div className="chat-toolbar">
          <div className="chat-model-group">
            <label>MODEL</label>
            <div className="select-wrap">
              <select
                value={active.model}
                onChange={e => {
                  const model = e.target.value;

                  if (model === WCKD_AUTO_MODEL) {
                    updateActive({
                      model,
                      thinkingLevel: "off",
                      thinking: false,
                    });
                    return;
                  }

                  const allowed = thinkingChoices(model);
                  const level = allowed.includes("medium" as any) ? "medium" : "off";
                  updateActive({ model, thinkingLevel: level, thinking: level !== "off" });
                }}
                disabled={generating}
              >
                <option value={WCKD_AUTO_MODEL}>⚡ WCKD Auto</option>
                {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>

          <div className="chat-model-group">
            <label>PROFILE</label>
            <div className="profile-buttons">
              {(["fast","balanced","deep"] as const).map(p => (
                <button
                  key={p}
                  className={active.profile === p ? "selected" : ""}
                  onClick={() => applyProfile(p)}
                  disabled={generating}
                >
                  <Gauge size={11}/>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="chat-model-group">
            <label>CONTEXT</label>
            <div className="ctx-buttons">
              {ctxOptions.map(o => (
                <button
                  key={o.value}
                  className={active.context === o.value ? "selected" : ""}
                  onClick={() => updateActive({ context: o.value, profile: undefined })}
                  disabled={generating}
                >
                  {o.label}
                </button>
              ))}
              <input
                className="context-custom"
                type="number"
                min={1024}
                step={1024}
                value={active.context}
                onChange={e => updateActive({ context: Math.max(1024, Number(e.target.value) || 1024), profile: undefined })}
                disabled={generating}
                title="Custom context"
              />
            </div>
          </div>

          {active.model !== WCKD_AUTO_MODEL && supportsThinking(active.model) && (
            <div className="chat-model-group">
              <label>THINKING</label>
              <div className="select-wrap thinking-select">
                <select
                  value={active.thinkingLevel || "off"}
                  onChange={e => {
                    const level = e.target.value as "off" | "low" | "medium" | "high";
                    updateActive({ thinkingLevel: level, thinking: level !== "off", profile: undefined });
                  }}
                  disabled={generating}
                >
                  {thinkingChoices(active.model).map(level => (
                    <option key={level} value={level}>{level[0].toUpperCase() + level.slice(1)}</option>
                  ))}
                </select>
                <Brain size={13}/>
              </div>
            </div>
          )}

          <button className={`advanced-toggle ${showAdvanced ? "on" : ""}`} onClick={() => setShowAdvanced(!showAdvanced)}>
            <SlidersHorizontal size={14}/> Settings
          </button>

          <button
            className={`chat-activity-toggle ${chatActivityOpen ? "on" : ""}`}
            onClick={() => setChatActivityOpenPersisted(!chatActivityOpen)}
            title={chatActivityOpen ? "Hide Activity Console" : "Show Activity Console"}
          >
            <Terminal size={13}/> Activity
          </button>

          <div className={`chat-runtime-pill ${active.model === WCKD_AUTO_MODEL ? "auto" : ""}`}>
            <Circle size={7} fill="currentColor"/>
            {active.model === WCKD_AUTO_MODEL
              ? "WCKD Auto · Router + Web + Orchestrator"
              : ollamaOnline
                ? "Runtime online"
                : "Auto-start on send"}
          </div>
        </div>

        {showAdvanced && (
          <div className="chat-advanced">
            <div className="advanced-field">
              <label>TEMPERATURE <strong>{(active.temperature ?? 0.55).toFixed(2)}</strong></label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={active.temperature ?? 0.55}
                onChange={e => updateActive({ temperature: Number(e.target.value), profile: undefined })}
              />
            </div>
            <div className="advanced-field">
              <label>TOP P <strong>{(active.topP ?? 0.95).toFixed(2)}</strong></label>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.01"
                value={active.topP ?? 0.95}
                onChange={e => updateActive({ topP: Number(e.target.value), profile: undefined })}
              />
            </div>
            <div className="advanced-memory">
              <label>PROJECT MEMORY</label>
              <div className="advanced-memory-controls">
                <select
                  value={active.projectId || ""}
                  onChange={event => updateActive({ projectId: event.target.value })}
                  disabled={generating}
                >
                  <option value="">None</option>
                  {chatMemoryProjects.map(project => (
                    <option key={project.project_id} value={project.project_id}>
                      {project.project_id}
                    </option>
                  ))}
                </select>

                <label className="advanced-check">
                  <input
                    type="checkbox"
                    checked={active.memoryEnabled !== false}
                    onChange={event => updateActive({ memoryEnabled: event.target.checked })}
                    disabled={generating || !active.projectId}
                  />
                  USE
                </label>

                <label className="advanced-check">
                  <input
                    type="checkbox"
                    checked={active.saveResultToMemory !== false}
                    onChange={event => updateActive({ saveResultToMemory: event.target.checked })}
                    disabled={generating || !active.projectId}
                  />
                  SAVE
                </label>
              </div>
              <p>
                Used automatically when WCKD Auto escalates a work request to Orchestrator.
              </p>
            </div>

            <div className="advanced-system">
              <label>SYSTEM PROMPT</label>
              <textarea
                value={active.systemPrompt ?? ""}
                onChange={e => updateActive({ systemPrompt: e.target.value })}
                placeholder="Optional instructions for this conversation…"
                rows={2}
              />
            </div>
          </div>
        )}

        <div className={`chat-workspace ${chatActivityOpen ? "with-session-console" : ""}`}>
          <div className="chat-conversation-pane">
        <div className="messages">
          <div className={`messages-inner ${active.messages.length === 0 ? "empty" : ""}`}>
          {active.messages.length === 0 && (
            <div className="chat-empty-state">
              <div className="chat-empty-icon"><Bot size={30}/></div>
              <h2>What are we working on?</h2>
              <p>{active.model === WCKD_AUTO_MODEL ? "WCKD Auto" : (active.model || "Select a model")} · {active.context / 1024}K context</p>
            </div>
          )}

          {active.messages.map(m => (
            <div key={m.id} className={`message-row ${m.role}`}>
              <div className={`message-avatar ${m.role}`}>
                {m.role === "assistant" ? <Bot size={17}/> : "A"}
              </div>
              <div className="message-body">
                <div className="message-meta">
                  <span>{m.role === "assistant" ? (active.model === WCKD_AUTO_MODEL ? "WCKD Auto" : active.model) : "You"}</span>
                  {m.createdAt && <time>{formatChatTimestamp(m.createdAt)}</time>}
                </div>

                {m.role === "assistant" && m.thinking && (
                  <div className="thinking-block">
                    <button onClick={() => setShowThinking(!showThinking)}>
                      <Brain size={14}/> Thinking <ChevronDown size={13}/>
                    </button>
                    {showThinking && <pre>{m.thinking}</pre>}
                  </div>
                )}
                {m.role === "assistant" && m.execution && (
                  <div className={`execution-evidence-card ${
                    m.execution.verified
                      ? (m.execution.recovered ? "recovered" : "verified")
                      : "unverified"
                  }`}>
                    <div className="execution-evidence-head">
                      <div className="execution-evidence-identity">
                        <span className="execution-verified-badge">
                          <ShieldCheck size={13}/>
                          {m.execution.verified
                            ? (m.execution.recovered ? "VERIFIED WITH RECOVERY" : "VERIFIED")
                            : "UNVERIFIED"}
                        </span>
                        <span className="execution-evidence-tools">
                          {m.execution.successfulToolResults ?? 0} tools OK
                          {" · "}
                          {m.execution.verified && (m.execution.failedToolResults ?? 0) > 0
                            ? `${m.execution.failedToolResults} recovered failure${m.execution.failedToolResults === 1 ? "" : "s"}`
                            : `${m.execution.failedToolResults ?? 0} failed`}
                        </span>
                        {m.execution.runnerJobId && (
                          <span className="execution-runner-id">
                            Runner: {m.execution.runnerJobId.slice(0, 12)}
                          </span>
                        )}
                      </div>

                      <button
                        className="execution-evidence-toggle"
                        onClick={() => setExpandedEvidence(prev => ({
                          ...prev,
                          [m.id]: !prev[m.id],
                        }))}
                      >
                        Evidence
                        <ChevronDown
                          size={13}
                          className={expandedEvidence[m.id] ? "expanded" : ""}
                        />
                      </button>
                    </div>

                    {expandedEvidence[m.id] && (
                      <div className="execution-evidence-body">
                        <div className="execution-evidence-grid">
                          <div>
                            <span>Verification Gate</span>
                            <strong>{m.execution.verificationGatePassed ? "PASS" : "FAIL"}</strong>
                          </div>
                          <div>
                            <span>Verification Turn</span>
                            <strong>{m.execution.verificationSuccessSeen ? "PASS" : "FAIL"}</strong>
                          </div>
                          <div>
                            <span>Tool Results</span>
                            <strong>
                              {m.execution.successfulToolResults ?? 0} OK / {m.execution.failedToolResults ?? 0} failed
                            </strong>
                          </div>
                          <div>
                            <span>Evidence Source</span>
                            <strong>{m.execution.evidenceSource || "unknown"}</strong>
                          </div>
                        </div>

                        <div className="execution-evidence-ids">
                          {m.execution.orchestratorJobId && (
                            <span>Orchestrator: <code>{m.execution.orchestratorJobId}</code></span>
                          )}
                          {m.execution.runnerJobId && (
                            <span>Runner: <code>{m.execution.runnerJobId}</code></span>
                          )}
                          {m.execution.workspace && (
                            <span>Workspace: <code>{m.execution.workspace}</code></span>
                          )}
                        </div>

                        {Boolean(m.execution.evidenceEvents?.length) && (
                          <div className="execution-event-list">
                            <div className="execution-event-title">Verification events</div>
                            {m.execution.evidenceEvents!.map((event, index) => (
                              <div className="execution-event-row" key={`${m.id}-evidence-${index}`}>
                                <span className={`execution-event-state ${event.ok === false ? "failed" : "ok"}`}>
                                  {event.ok === false ? "FAIL" : "OK"}
                                </span>
                                <div>
                                  <strong>
                                    {event.event || "event"}
                                    {event.tool ? ` · ${event.tool}` : ""}
                                    {event.step !== undefined ? ` · step ${event.step}` : ""}
                                  </strong>
                                  {(event.result || event.stdout || event.message) && (
                                    <pre>{event.result || event.stdout || event.message}</pre>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {m.execution.evidencePacket && (
                          <details className="execution-raw-evidence">
                            <summary>Raw evidence packet</summary>
                            <pre>{m.execution.evidencePacket}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {Boolean(m.attachments?.length) && (
                  <div className="message-attachments">
                    {m.attachments!.map(attachment => (
                      <div className={`message-attachment ${attachment.kind}`} key={attachment.id}>
                        {<div className="message-attachment-icon"><FileText size={16}/></div>}
                        <div>
                          <strong>{attachment.name}</strong>
                          <span>
                            {"FILE"} · {formatFileBytes(attachment.size)}
                            {attachment.truncated ? " · TRUNCATED" : ""}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="message-content">{m.content || (generating && m.role === "assistant" ? <span className="cursor-blink">▋</span> : "")}</div>

                {m.role === "assistant" && m.content && (
                  <div className="message-actions">
                    <button className="copy-button" onClick={() => copyMessage(m.id, m.content)}>
                      {copiedId === m.id ? <Check size={13}/> : <Copy size={13}/>}
                      {copiedId === m.id ? "Copied" : "Copy"}
                    </button>
                    {m.content.startsWith("Error:") && (
                      <button className="copy-button retry" onClick={() => retryAssistant(m.id)}>
                        <RotateCcw size={13}/> Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div className="messages-end" ref={endRef}/>
          </div>
        </div>


            <div className="chat-bottom">
          {stats && (
            <div className="chat-stats">
              {stats.generationTokS !== undefined && <span><strong>{stats.generationTokS.toFixed(1)}</strong> tok/s</span>}
              {stats.promptTokS !== undefined && <span><strong>{stats.promptTokS.toFixed(0)}</strong> prompt tok/s</span>}
              {stats.promptTokens !== undefined && <span>{stats.promptTokens} prompt</span>}
              {stats.outputTokens !== undefined && <span>{stats.outputTokens} output</span>}
              {stats.totalSeconds !== undefined && <span>{stats.totalSeconds.toFixed(1)}s</span>}
            </div>
          )}

          {pendingAttachments.length > 0 && (
            <div className="pending-attachments">
              {pendingAttachments.map(attachment => (
                <div className={`pending-attachment ${attachment.kind}`} key={attachment.id}>
                  {<div className="pending-attachment-icon"><FileText size={16}/></div>}
                  <div className="pending-attachment-copy">
                    <strong>{attachment.name}</strong>
                    <span>
                      {formatFileBytes(attachment.size)}
                      {attachment.truncated ? " · first 256 KB" : ""}
                    </span>
                  </div>
                  <button
                    onClick={() => removePendingAttachment(attachment.id)}
                    disabled={generating}
                    title="Remove attachment"
                  >
                    <X size={13}/>
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer">
            <input
              ref={fileInputRef}
              className="attachment-file-input"
              type="file"
              multiple
              accept=".txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.js,.jsx,.ts,.tsx,.py,.ps1,.bat,.cmd,.sh,.html,.css,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.sql,.c,.cpp,.h,.hpp,.cs,.java,.go,.rs,.gd,.godot,.tres,.tscn,.shader,text/*"
              onChange={event => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                void addAttachmentFiles(files);
              }}
            />
            <button
              className="attach-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={generating}
              title="Attach text/code file"
            >
              <Paperclip size={17}/>
            </button>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={`Message ${active.model === WCKD_AUTO_MODEL ? "WCKD Auto" : (active.model || "local model")}…`}
              rows={1}
              disabled={generating}
              onPaste={event => {
                const files = Array.from(event.clipboardData.files || []);
                if (files.length) {
                  event.preventDefault();
                  void addAttachmentFiles(files);
                }
              }}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {generating ? (
              <button className="send-button stop" onClick={stop} title="Stop generation">
                <Square size={17}/>
              </button>
            ) : (
              <button
                className="send-button"
                onClick={send}
                disabled={(!input.trim() && pendingAttachments.length === 0) || !active.model}
                title="Send"
              >
                <Send size={17}/>
              </button>
            )}
          </div>
          <div className="composer-hint">
            Enter to send ? Shift+Enter new line ? Ctrl+V / drag&drop / paperclip for text/code attachments
          </div>
        </div>

          </div>

          {chatActivityOpen && (
            <aside className="chat-session-console-pane">
          {chatActivityOpen && (
            <div className="chat-activity-console">
              <div className="chat-activity-header">
                <div className="chat-activity-title">
                  <Terminal size={13}/>
                  <strong>SESSION CONSOLE</strong>
                  <span className={generating ? "running" : "idle"}>
                    {generating ? "RUNNING" : "IDLE"}
                  </span>
                </div>
                <div className="chat-activity-actions">
                  <button
                    className={chatActivityPaused ? "active" : ""}
                    onClick={() => setChatActivityPaused(!chatActivityPaused)}
                    title={chatActivityPaused ? "Resume activity feed" : "Pause activity feed"}
                  >
                    {chatActivityPaused ? <Play size={11}/> : <Square size={10}/>}
                  </button>
                  <button
                    onClick={() => {
                      chatActivitySeenRef.current.clear();
                      setChatActivityEvents([]);
                      void refreshChatActivity();
                    }}
                    title="Reload full session activity"
                  >
                    <RefreshCw size={11}/>
                  </button>
                  <button
                    onClick={() => setChatActivityOpenPersisted(false)}
                    title="Collapse activity console"
                  >
                    <ChevronDown size={12}/>
                  </button>
                </div>
              </div>

              <div className="chat-activity-body">
                {chatActivityEvents.length === 0 && (
                  <div className="chat-activity-empty">
                    {chatActivityPaused
                      ? "Session Console paused."
                      : active.messages.length === 0
                        ? "This chat has no activity yet."
                        : "No recorded activity for this session yet. New requests will be logged here."}
                  </div>
                )}

                {chatActivityEvents.map(event => (
                  <div
                    key={event.id}
                    className={`chat-activity-event level-${event.level}`}
                    title={event.data ? JSON.stringify(event.data, null, 2) : event.text}
                  >
                    <span className="chat-activity-time">
                      {event.ts ? new Date(event.ts).toLocaleTimeString([], { hour12: false }) : "--:--:--"}
                    </span>
                    <span className={`chat-activity-source source-${event.source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
                      {event.source}
                    </span>
                    <span className="chat-activity-name">{event.event}</span>
                    <span className="chat-activity-text">{event.text}</span>
                  </div>
                ))}
                <div ref={chatActivityEndRef}/>
              </div>
            </div>
          )}


            </aside>
          )}
        </div>
      </div>
    </section>
  );
}

function Placeholder({ title, copy, icon: Icon }: { title: string; copy: string; icon: any }) {
  return (
    <section className="content">
      <div className="placeholder panel">
        <div className="placeholder-icon"><Icon size={28}/></div>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    </section>
  );
}
