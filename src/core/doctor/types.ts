/**
 * The doctor's data shapes, on their own so a backend factory can declare
 * its checks (`BackendFactory.doctor`) without importing the collector —
 * `core/doctor/index.ts` reads the registry, so the types living there would
 * close a cycle. Checks are pure data (label / status / detail); renderers
 * decide presentation.
 */

type DoctorStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  label: string;
  status: DoctorStatus;
  detail?: string;
  /**
   * Counts toward the issue total even when status is "warn" — used
   * for soft failures like missing backend auth where the bot still
   * starts but a backend won't work.
   */
  issue?: boolean;
  /**
   * A backend that is configured but not serving chats. Renderers group
   * these away from the environment so a handful of idle providers can't
   * bury the checks that describe the running deployment.
   */
  inactive?: boolean;
}

/** One embedded native module: provenance plus a live self-test result. */
export interface NativeModuleCheck {
  name: string;
  /** Source language ("Rust", "Zig", "C", "C++", "Gleam"). */
  language: string;
  /** Compile target ("wasm32-unknown-unknown", "wasm32-freestanding", "JavaScript"). */
  target: string;
  /** Embedded artifact size, when the module ships as wasm bytes. */
  sizeBytes?: number;
  ok: boolean;
  /** Failure detail when !ok. */
  note?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  native: NativeModuleCheck[];
  /** Failed checks + warn-with-issue checks + failed native modules. */
  issues: number;
}

/**
 * The slice of config doctor reads. Both the CLI's local Config and
 * TalonConfig satisfy this structurally.
 */
export interface DoctorConfigSlice {
  frontend: string | string[];
  backend?: string;
  /** Backends config exposes. Empty / absent means every registered one. */
  enabledBackends?: string[];
  model?: string;
  heartbeatModel?: string;
  heartbeatBackend?: string;
  dreamBackend?: string;
  /** Extra Claude accounts (`claudeAccounts`), as written in config. */
  claudeAccounts?: { id: string; label?: string; configDir: string }[];
  botToken?: string;
  teamsWebhookUrl?: string;
  discord?: { botToken?: string };
  whatsapp?: object;
  claudeBinary?: string;
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  mempalace?: {
    enabled?: boolean;
    pythonPath?: string;
    version?: string;
  };
  playwright?: {
    enabled?: boolean;
    browser?: string;
    endpoint?: string;
    endpointFile?: string;
  };
  github?: { enabled?: boolean; imageTag?: string };
}
