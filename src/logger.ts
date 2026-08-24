import { hostname } from "node:os";
import pino from "pino";
import { config } from "@/config";
import { CORE_VERSION } from "@/core/index";

//The single logger. One instance, configured here, imported everywhere — so every
//event carries the same envelope and nothing formats itself differently.
//
//Two levels only: info for what happened, error for what broke. There is no debug
//tier by design; a wide event with the right fields answers what debug lines used
//to, and it answers it in production.

//Belt, not the rule. The rule is that secrets never enter the event in the first
//place — every enrich() call site picks its fields deliberately. This catches the
//accident: a whole player row or an error carrying config spread into an event.
//pino wildcards match one level only, so these are the shapes we actually build.
const REDACT_PATHS = [
  "token",
  "password",
  "password_hash",
  "luanti_password",
  "enc_private_key",
  "encPrivateKey",
  "kdfSalt",
  "kdf_salt",
  "public_key",
  "publicKey",
  "btcNodeUrl",
  "*.token",
  "*.password",
  "*.password_hash",
  "*.luanti_password",
  "*.enc_private_key",
  "*.encPrivateKey",
  "*.kdfSalt",
  "*.kdf_salt",
  "*.public_key",
  "*.publicKey",
  "*.btcNodeUrl",
  "*.authorization",
  '*["x-luanti-secret"]',
];

//Environment characteristics every event inherits. core_version and algo_version
//are here because this server derives stats and progression from the ruleset on
//read — an event without them cannot be interpreted after the ruleset moves.
function baseFields() {
  return {
    service: "hashimon-server",
    env: config.env,
    commit: config.commitSha,
    instance: hostname(),
    core_version: CORE_VERSION,
    algo_version: config.algoVersion,
    mining_mode: config.miningMode,
  };
}

//A destination is injectable so the wide-event test can read what was emitted
//without spawning a process. Production never passes one.
export function createLogger(destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    level: "info",
    base: baseFields(),
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "message",
    //pino writes numeric levels by default; with only info and error in play the
    //label is what a query filters on, so emit the label itself.
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { error: pino.stdSerializers.err },
  };

  if (destination) {
    return pino(options, destination);
  }
  //pino-pretty is a devDependency and never reaches the image: in a container the
  //runtime collects the raw JSON from stdout.
  if (config.env === "development") {
    return pino({ ...options, transport: { target: "pino-pretty" } });
  }
  return pino(options);
}

export const logger = createLogger();
