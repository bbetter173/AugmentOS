//
//  JSCExperiment.swift
//  MentraOS
//
//  Spike: measure the actual memory cost of N concurrent JSContexts on iOS.
//  We want to know whether "Pebble-style native JSC per miniapp" is viable
//  for our N-concurrent-miniapp use case (Pebble runs only 1 at a time, so
//  they have no data on this).
//
//  Each spawned context:
//   - Has its own JSVirtualMachine (full isolation, separate heap)
//   - Has __dispatch as a single bridge function (no per-method bindings,
//     to avoid the production crash Pebble documented in CrashReproducer.kt)
//   - Runs a representative idle workload: setInterval ping every 5 s
//   - Names itself "MentraJS: <id>" for Safari Web Inspector
//   - Is NOT inspectable in release builds
//
//  Measure resident memory before and after spawning N contexts.

import Foundation
import JavaScriptCore

@objc public class JSCExperiment: NSObject {
    /// id → (context, virtualMachine, timer for the workload)
    private static var contexts: [String: (JSContext, JSVirtualMachine, Timer)] = [:]
    private static let queue = DispatchQueue(label: "com.mentra.jsc-experiment")

    /// Spawn N JSContexts at once. Each gets its own VM + a representative
    /// idle workload. Returns the count successfully spawned.
    @objc public static func spawn(count: Int) -> Int {
        var spawned = 0
        for i in 0..<count {
            let id = "spike-\(UUID().uuidString.prefix(8))-\(i)"
            if spawnOne(id: id) {
                spawned += 1
            }
        }
        Bridge.log("📊 JSCExperiment: spawned \(spawned) contexts (total now: \(contexts.count))")
        return spawned
    }

    /// Spawn one named context. Returns true on success.
    @objc public static func spawnOne(id: String) -> Bool {
        return queue.sync {
            // Each context gets its own VM = full heap isolation between miniapps.
            // (JSContexts that share a VM share the heap; we want isolation.)
            let vm = JSVirtualMachine()!
            let ctx = JSContext(virtualMachine: vm)!

            ctx.name = "MentraJS: \(id)"
            // Inspectable in dev builds only. iOS 16.4+ guarded.
            #if DEBUG
            if #available(iOS 16.4, *) {
                ctx.isInspectable = true
            }
            #endif

            // Single-dispatcher bridge. Per Pebble's CrashReproducer doc, never
            // bind individual native callbacks as JSValue properties — JSC's GC
            // races with ARC and crashes. One C-callable function only.
            let dispatch: @convention(block) (String, String, [Any]?) -> Any? = { iface, method, args in
                // Stub: real impl routes to native services.
                // For the spike we just need __dispatch to exist so the
                // workload can call it without throwing.
                return NSNull()
            }
            ctx.setObject(dispatch, forKeyedSubscript: "__dispatch" as NSString)

            // Representative idle workload — what a typical miniapp's
            // background JS does: hold a tiny bit of state, register a
            // listener, periodically poke the bridge.
            let workload = """
              (function () {
                var counter = 0;
                var state = { id: \"\(id)\", startedAt: Date.now(), notes: [] };
                var i = 0;
                function tick() {
                  counter++;
                  state.notes.push({ at: Date.now(), n: counter });
                  if (state.notes.length > 100) state.notes.shift();
                  __dispatch('noop', 'tick', [counter]);
                }
                tick();
                // Schedule a periodic tick. We use the host-provided
                // setInterval (a JS shim that calls into native).
                if (typeof setInterval === 'function') {
                  setInterval(tick, 5000);
                }
              })();
            """
            ctx.evaluateScript(workload)

            // Workload uses setInterval which is a JS shim that we'd build
            // for real — for the spike we just install a Timer-based
            // setInterval that fires the JS callback. The JS code already
            // expects setInterval to exist as a global.
            let setInterval: @convention(block) (JSValue, Double) -> Int = { fn, ms in
                let id = Int.random(in: 1...Int.max)
                // Stub: we won't actually fire in the spike, but the JS
                // callback existing is what we want for memory measurement.
                _ = fn // hold a ref to keep the JS callback alive
                _ = ms
                return id
            }
            ctx.setObject(setInterval, forKeyedSubscript: "setInterval" as NSString)

            // Idle workload Timer on the native side that does NOTHING —
            // it just exists so the context isn't optimized away. The real
            // JS callback (registered above) will be hit by a real
            // setInterval impl in production.
            let timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
                // no-op — keep ref alive
            }

            contexts[id] = (ctx, vm, timer)
            return true
        }
    }

    /// Tear down all contexts. Important: cancel timers, drop refs, force GC.
    @objc public static func killAll() {
        queue.sync {
            for (_, entry) in contexts {
                entry.2.invalidate()
            }
            let count = contexts.count
            contexts.removeAll()
            Bridge.log("📊 JSCExperiment: killed all \(count) contexts")
        }
    }

    /// How many contexts are alive right now.
    @objc public static func aliveCount() -> Int {
        return queue.sync { contexts.count }
    }

    /// Convenience: spawn N + return memory delta vs baseline. Caller
    /// records baseline via MemoryMonitor.currentMemoryMB() before calling.
    @objc public static func spawnAndMeasure(count: Int, baselineMB: Double) -> [String: Any] {
        let beforeMB = MemoryMonitor.currentMemoryMB()
        let spawned = spawn(count: count)
        // Tiny settle delay so allocations complete before we read.
        Thread.sleep(forTimeInterval: 0.5)
        let afterMB = MemoryMonitor.currentMemoryMB()
        let perContextMB = spawned > 0 ? (afterMB - beforeMB) / Double(spawned) : 0
        let result: [String: Any] = [
            "spawned": spawned,
            "totalAlive": aliveCount(),
            "baselineMB": baselineMB,
            "beforeMB": beforeMB,
            "afterMB": afterMB,
            "deltaMB": afterMB - beforeMB,
            "perContextMB": perContextMB,
        ]
        Bridge.log("📊 JSCExperiment.spawnAndMeasure: \(result)")
        return result
    }
}
