import { clearSdkAuthCache } from "../sdk/sdk.auth.service";

/**
 * AppCacheService — In-memory cache for the `apps` collection.
 *
 * Why: Every `App.findOne({ packageName })` on a hot path blocks the event loop
 * for 80ms (US Central) to 370ms (East Asia) of pure MongoDB network RTT.
 * With 65 sessions, each triggering multiple app lookups during connect/reconnect,
 * the cumulative blocking contributes to health check timeouts and pod crashes.
 *
 * The `apps` collection is 1,314 documents, ~2 MB total. It changes rarely.
 * This cache loads all docs at boot and refreshes every 30 seconds.
 * Hot-path lookups become instant memory reads (0ms) instead of network round-trips.
 *
 * Multi-pod staleness: Write-through invalidation works on the local pod only.
 * Other pods (in other regions) wait for the next 30s refresh cycle. This means
 * critical fields (publicUrl, hashedApiKey, permissions) can be stale for up to
 * 30 seconds on non-local pods after a developer update.
 *
 * See: cloud/issues/062-mongodb-latency/spec.md (B3)
 */

import mongoose from "mongoose";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "AppCache" });

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds — bounds worst-case staleness
const STALE_WARNING_MS = 90_000; // warn if 3 missed refresh cycles

// We import the App model lazily to avoid circular dependency issues.
// The model is imported at runtime when initialize() is called, not at module load.
let AppModel: mongoose.Model<any> | null = null;

function getAppModel(): mongoose.Model<any> {
  if (!AppModel) {
    // Dynamically resolve — the model is registered by the time initialize() runs
    AppModel = mongoose.models.App || null;
    if (!AppModel) {
      throw new Error("AppCache: App model not registered in Mongoose. Call initialize() after MongoDB connects.");
    }
  }
  return AppModel;
}

class AppCacheService {
  private byPackageName: Map<string, any> = new Map();
  private allApps: any[] = [];
  private refreshInterval?: NodeJS.Timeout;
  private loaded = false;
  private lastRefresh: number = 0;
  private refreshCount: number = 0;
  private refreshing = false;

  /**
   * Load the cache and start the refresh timer.
   * Call AFTER MongoDB connects and models are registered.
   */
  async initialize(): Promise<void> {
    // Start interval BEFORE initial refresh so retries happen even if first refresh fails
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((err) => {
        logger.error(err, "App cache refresh failed");
      });

      // Detect stale cache (3 missed refresh cycles)
      if (this.loaded && Date.now() - this.lastRefresh > STALE_WARNING_MS) {
        logger.warn(
          {
            feature: "app-cache",
            lastRefreshAgo: Math.round((Date.now() - this.lastRefresh) / 1000),
          },
          "App cache is stale — refresh may be failing",
        );
      }
    }, REFRESH_INTERVAL_MS);

    try {
      await this.refresh();
    } catch (err) {
      logger.error(err, "App cache initial refresh failed — interval will retry");
    }

    logger.info(
      {
        feature: "app-cache",
        count: this.byPackageName.size,
        refreshIntervalMs: REFRESH_INTERVAL_MS,
      },
      `App cache initialized: ${this.byPackageName.size} apps, refreshing every ${REFRESH_INTERVAL_MS / 1000}s`,
    );
  }

  /**
   * Reload all apps from MongoDB. Uses .lean() for minimal overhead.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      logger.debug({ feature: "app-cache" }, "Refresh already in progress — skipping");
      return;
    }
    this.refreshing = true;
    try {
      const t0 = performance.now();
      const App = getAppModel();
      const apps = await App.find({}).lean();
      const elapsed = performance.now() - t0;

      const newMap = new Map<string, any>();
      for (const app of apps) {
        if (app.packageName) {
          newMap.set(app.packageName, app);
        }
      }

      // Atomic swap — no partial state visible to readers
      this.byPackageName = newMap;
      this.allApps = apps;
      this.loaded = true;
      this.lastRefresh = Date.now();
      this.refreshCount++;

      // Log every refresh (once per 30s = 2,880/day — negligible)
      logger.info(
        {
          feature: "app-cache",
          count: apps.length,
          refreshMs: Math.round(elapsed * 10) / 10,
          refreshCount: this.refreshCount,
        },
        `App cache refreshed: ${apps.length} apps in ${Math.round(elapsed)}ms`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Look up an app by packageName. Returns a lean document or null.
   * This is the hot-path replacement for `App.findOne({ packageName })`.
   * Returns null if the cache isn't loaded yet (caller should fall back to DB).
   */
  getByPackageName(packageName: string): any | null {
    if (!this.loaded) {
      logger.warn({ feature: "app-cache", packageName }, "App cache not loaded yet — caller should fall back to DB");
      return null;
    }
    return this.byPackageName.get(packageName) ?? null;
  }

  /**
   * Look up multiple apps by packageNames. Returns lean documents.
   * Hot-path replacement for `App.find({ packageName: { $in: [...] } })`.
   */
  getByPackageNames(packageNames: string[]): any[] {
    if (!this.loaded) return [];
    return packageNames.map((name) => this.byPackageName.get(name)).filter((app): app is any => app != null);
  }

  /**
   * Get all cached apps. Hot-path replacement for `App.find({})`.
   */
  getAll(): any[] {
    return this.allApps;
  }

  /**
   * Force an immediate cache refresh. Call after any write to the apps collection
   * (create, update, delete) to minimize staleness on the LOCAL pod.
   *
   * Other pods in other regions will pick up the change on their next 30s refresh.
   */
  async invalidate(): Promise<void> {
    try {
      clearSdkAuthCache();
      await this.refresh();
    } catch (err) {
      logger.error(err, "App cache invalidation refresh failed");
    }
  }

  /**
   * Whether the cache has been loaded at least once.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * How many apps are cached.
   */
  size(): number {
    return this.byPackageName.size;
  }

  /**
   * Stop the refresh timer. Call on server shutdown.
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    logger.info("App cache stopped");
  }
}

export const appCache = new AppCacheService();
