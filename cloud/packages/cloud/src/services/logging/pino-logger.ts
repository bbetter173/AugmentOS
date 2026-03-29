import pino from "pino";

// Constants and configuration
const DEPLOYMENT_REGION = process.env.DEPLOYMENT_REGION;
const isChina = DEPLOYMENT_REGION === "china";

const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN;
const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com";
const NODE_ENV = process.env.NODE_ENV || "development";
const REGION = process.env.REGION || process.env.DEPLOYMENT_REGION || "";
const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local";

// When LOG_STDOUT_JSON=true, write raw JSON to stdout instead of pino-pretty.
// This allows an external log collector (Vector/BetterStack Kubernetes Helm chart)
// to pick up structured JSON from container stdout and ship it to BetterStack
// WITHOUT the in-process @logtail/pino transport that causes unbounded heap growth.
//
// The @logtail/pino transport stays active alongside stdout so we can verify
// both paths deliver logs before removing the in-process transport.
//
// See: cloud/issues/067-heap-growth-investigation/spike.md
const LOG_STDOUT_JSON = process.env.LOG_STDOUT_JSON === "true";

// Log filtering configuration
const LOG_FEATURES = process.env.LOG_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_EXCLUDE_FEATURES = process.env.LOG_EXCLUDE_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_SERVICES = process.env.LOG_SERVICES?.split(",").map((s) => s.trim()) || [];
const LOG_EXCLUDE_SERVICES = process.env.LOG_EXCLUDE_SERVICES?.split(",").map((s) => s.trim()) || [];

// Check once at startup whether any filters are configured.
// If not, skip the JSON.parse in createFilteredStream entirely — avoids
// ~200-340 useless JSON.parse calls/sec on the main thread in production.
const HAS_LOG_FILTERS =
  LOG_FEATURES.length > 0 ||
  LOG_EXCLUDE_FEATURES.length > 0 ||
  LOG_SERVICES.length > 0 ||
  LOG_EXCLUDE_SERVICES.length > 0;

// Determine log level based on environment
// Use 'info' in development to reduce noise from debug logs
const LOG_LEVEL = NODE_ENV === "production" ? "info" : "debug";

// Custom filtering function
const shouldLogMessage = (logObj: any): boolean => {
  // If no filters are set, log everything
  if (!HAS_LOG_FILTERS) {
    return true;
  }

  const feature = logObj.feature;
  const service = logObj.service;

  // Check feature filters
  if (LOG_FEATURES.length > 0 && (!feature || !LOG_FEATURES.includes(feature))) {
    return false;
  }

  if (LOG_EXCLUDE_FEATURES.length > 0 && feature && LOG_EXCLUDE_FEATURES.includes(feature)) {
    return false;
  }

  // Check service filters
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

// Custom filtering stream wrapper.
// When no filters are configured (the common case in production), returns the
// target stream directly — zero overhead, no JSON.parse per log line.
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
        // If we can't parse the JSON, pass it through
        targetStream.write(line);
      }
    },
  };
};

// ── Stdout stream ──────────────────────────────────────────────────────────
// LOG_STDOUT_JSON=true  → raw JSON to stdout (for Vector / external collector)
// LOG_STDOUT_JSON=false → pino-pretty to stdout (for human readability)

if (LOG_STDOUT_JSON) {
  // Raw JSON to stdout — Vector picks this up from container logs and ships
  // it to BetterStack with full Kubernetes metadata. No worker thread, no
  // in-process buffer, no memory growth.
  const stdoutDest = pino.destination({ dest: 1, sync: false });
  const filteredStdout = createFilteredStream(stdoutDest, LOG_LEVEL);

  streams.push({
    stream: filteredStdout,
    level: LOG_LEVEL,
  });
} else {
  // Pretty transport for development / legacy production with filtering
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

// ── BetterStack in-process transport ───────────────────────────────────────
// Kept active alongside stdout so we can verify both paths deliver logs
// before removing it. Once Vector log collection is confirmed working on all
// clusters, this block can be removed entirely.

if (BETTERSTACK_SOURCE_TOKEN && !isChina) {
  const betterStackTransport = pino.transport({
    target: "@logtail/pino",
    options: {
      sourceToken: BETTERSTACK_SOURCE_TOKEN,
      options: { endpoint: BETTERSTACK_ENDPOINT },
    },
  });

  const filteredBetterStackStream = createFilteredStream(betterStackTransport, LOG_LEVEL);

  streams.push({
    stream: filteredBetterStackStream,
    level: LOG_LEVEL,
  });
} else if (isChina) {
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
  logger.info(
    { LOG_STDOUT_JSON: true, HAS_LOG_FILTERS },
    "Pino logger: JSON stdout enabled (for Vector log collection)",
  );
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
