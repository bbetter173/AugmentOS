import pino from "pino";

// Constants and configuration
const DEPLOYMENT_REGION = process.env.DEPLOYMENT_REGION;
const isChina = DEPLOYMENT_REGION === "china";

const NODE_ENV = process.env.NODE_ENV || "development";
const REGION = process.env.REGION || process.env.DEPLOYMENT_REGION || "";
const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local";

// When LOG_STDOUT_JSON=true, write raw JSON to stdout instead of pino-pretty.
// Vector (BetterStack Kubernetes Helm chart) picks up the JSON from container
// stdout and ships it to BetterStack — no in-process transport, no worker
// thread buffer, no heap growth.
//
// When LOG_STDOUT_JSON is not set (dev/local), pino-pretty writes to console
// for human readability.
//
// See: cloud/issues/067-heap-growth-investigation/spike.md
const LOG_STDOUT_JSON = process.env.LOG_STDOUT_JSON === "true";

// Log filtering configuration (optional — used for debugging specific features/services)
const LOG_FEATURES = process.env.LOG_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_EXCLUDE_FEATURES = process.env.LOG_EXCLUDE_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_SERVICES = process.env.LOG_SERVICES?.split(",").map((s) => s.trim()) || [];
const LOG_EXCLUDE_SERVICES = process.env.LOG_EXCLUDE_SERVICES?.split(",").map((s) => s.trim()) || [];

// Check once at startup whether any filters are configured.
// If not, skip the JSON.parse in createFilteredStream entirely — avoids
// unnecessary JSON.parse calls on the main thread.
const HAS_LOG_FILTERS =
  LOG_FEATURES.length > 0 ||
  LOG_EXCLUDE_FEATURES.length > 0 ||
  LOG_SERVICES.length > 0 ||
  LOG_EXCLUDE_SERVICES.length > 0;

// Determine log level based on environment
const LOG_LEVEL = NODE_ENV === "production" ? "info" : "debug";

// Custom filtering function
const shouldLogMessage = (logObj: any): boolean => {
  if (!HAS_LOG_FILTERS) {
    return true;
  }

  const feature = logObj.feature;
  const service = logObj.service;

  if (LOG_FEATURES.length > 0 && (!feature || !LOG_FEATURES.includes(feature))) {
    return false;
  }

  if (LOG_EXCLUDE_FEATURES.length > 0 && feature && LOG_EXCLUDE_FEATURES.includes(feature)) {
    return false;
  }

  if (LOG_SERVICES.length > 0 && (!service || !LOG_SERVICES.includes(service))) {
    return false;
  }

  if (LOG_EXCLUDE_SERVICES.length > 0 && service && LOG_EXCLUDE_SERVICES.includes(service)) {
    return false;
  }

  return true;
};

// Setup streams array for Pino multistream
const streams: pino.StreamEntry[] = [];

// Filtering stream wrapper — only wraps with JSON.parse when filters are set.
const createFilteredStream = (targetStream: any, _level: string) => {
  if (!HAS_LOG_FILTERS) {
    return targetStream;
  }
  return {
    write: (line: string) => {
      try {
        const logObj = JSON.parse(line);
        if (shouldLogMessage(logObj)) {
          targetStream.write(line);
        }
      } catch {
        targetStream.write(line);
      }
    },
  };
};

// ── Stdout stream ──────────────────────────────────────────────────────────
// LOG_STDOUT_JSON=true  → raw JSON to stdout (Vector picks it up, ships to BetterStack)
// LOG_STDOUT_JSON=false → pino-pretty to stdout (dev/local readability)

if (LOG_STDOUT_JSON) {
  const stdoutDest = pino.destination({ dest: 1, sync: false });
  const filteredStdout = createFilteredStream(stdoutDest, LOG_LEVEL);

  streams.push({
    stream: filteredStdout,
    level: LOG_LEVEL,
  });
} else {
  const prettyTransport = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname,env,service,server,req,res,responseTime",
      messageFormat: "{msg}",
      errorProps: "*",
    },
  });

  const filteredPrettyStream = createFilteredStream(prettyTransport, LOG_LEVEL);

  streams.push({
    stream: filteredPrettyStream,
    level: LOG_LEVEL,
  });
}

// ── No in-process BetterStack transport ────────────────────────────────────
// Previously we used @logtail/pino here, which ran in a Pino worker thread
// via thread-stream. When the BetterStack HTTP API couldn't consume logs as
// fast as we produced them (~100-170/sec), the thread-stream buffer grew
// without bound — causing ~15 MB/min heap growth and eventual pod crashes.
//
// Log delivery is now handled by Vector (BetterStack Kubernetes Helm chart),
// which runs as a DaemonSet outside the Node process. It tails container
// stdout, flattens the Pino JSON, and ships to BetterStack with proper
// backpressure handling. Zero in-process memory overhead.
//
// See: cloud/issues/067-heap-growth-investigation/spike.md
// See: cloud/infra/betterstack-logs/values.yaml

if (isChina) {
  console.log("BetterStack is disabled for China");
}

// Create multistream
const multistream = pino.multistream(streams);

/**
 * Configuration for the root logger
 */
const baseLoggerOptions: pino.LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    env: NODE_ENV,
    server: PORTER_APP_NAME,
    region: REGION,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Create the root logger with multiple streams
export const logger = pino(baseLoggerOptions, multistream);

// Log the current configuration on startup
if (LOG_STDOUT_JSON) {
  logger.info({ LOG_STDOUT_JSON: true, HAS_LOG_FILTERS }, "Pino logger: JSON stdout enabled (Vector log collection)");
}

if (HAS_LOG_FILTERS) {
  logger.info(
    {
      LOG_FEATURES: LOG_FEATURES.length > 0 ? LOG_FEATURES : undefined,
      LOG_EXCLUDE_FEATURES: LOG_EXCLUDE_FEATURES.length > 0 ? LOG_EXCLUDE_FEATURES : undefined,
      LOG_SERVICES: LOG_SERVICES.length > 0 ? LOG_SERVICES : undefined,
      LOG_EXCLUDE_SERVICES: LOG_EXCLUDE_SERVICES.length > 0 ? LOG_EXCLUDE_SERVICES : undefined,
    },
    "Log filtering enabled",
  );
}

// Default export is the logger
export default logger;
