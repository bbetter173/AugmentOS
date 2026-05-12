import Foundation
import JavaScriptCore

/// One JSContext per id, each on its own JSVirtualMachine for full heap
/// isolation. Adapted from bluetooth-sdk's JSCExperiment.spawnOne — see the
/// comments there for the rule about single-dispatcher bridging (never bind
/// individual native callbacks as JSValue properties).
final class JscRuntime {
  static let shared = JscRuntime()

  /// One serial queue per context. JSContext is not thread-safe — every
  /// access (evaluate, callback into JS) must run on this queue.
  final class ContextHandle {
    let id: String
    let vm: JSVirtualMachine
    let ctx: JSContext
    let queue: DispatchQueue
    var timers: [Int: DispatchSourceTimer] = [:]
    var nextTimerId: Int = 1
    /// JS-side __resolveFetch and __resolveBridge callbacks live in JS;
    /// we just need a counter for unique tokens.
    var nextToken: Int = 1

    init(id: String, vm: JSVirtualMachine, ctx: JSContext) {
      self.id = id
      self.vm = vm
      self.ctx = ctx
      self.queue = DispatchQueue(label: "com.mentra.jsc.\(id)")
    }
  }

  private let mapQueue = DispatchQueue(label: "com.mentra.jsc.map")
  private var contexts: [String: ContextHandle] = [:]
  private weak var module: JscModule?

  func bind(module: JscModule) {
    mapQueue.sync { self.module = module }
  }

  func listIds() -> [String] {
    mapQueue.sync { Array(contexts.keys) }
  }

  func handle(id: String) -> ContextHandle? {
    mapQueue.sync { contexts[id] }
  }

  // MARK: - Lifecycle

  enum JscError: Error, CustomStringConvertible {
    case duplicateId(String)
    case unknownId(String)
    case scriptThrew(String)
    case vmAllocFailed

    var description: String {
      switch self {
      case let .duplicateId(id): return "Jsc: context '\(id)' already exists"
      case let .unknownId(id): return "Jsc: no context with id '\(id)'"
      case let .scriptThrew(msg): return "Jsc: script threw: \(msg)"
      case .vmAllocFailed: return "Jsc: failed to allocate JSVirtualMachine"
      }
    }
  }

  func create(id: String) throws {
    if mapQueue.sync(execute: { contexts[id] != nil }) {
      throw JscError.duplicateId(id)
    }
    guard let vm = JSVirtualMachine() else { throw JscError.vmAllocFailed }
    guard let ctx = JSContext(virtualMachine: vm) else { throw JscError.vmAllocFailed }

    ctx.name = "MentraJS: \(id)"
    #if DEBUG
    if #available(iOS 16.4, *) {
      ctx.isInspectable = true
    }
    #endif

    let handle = ContextHandle(id: id, vm: vm, ctx: ctx)

    // Capture weak module so callbacks don't pin the Module.
    weak var weakModule = mapQueue.sync { module }
    weak var weakHandle = handle

    // Exception handler — surfaces uncaught JS errors as jsc_error events.
    ctx.exceptionHandler = { _, exception in
      guard let exception = exception else { return }
      let message = exception.toString() ?? "<unknown>"
      let stack = exception.objectForKeyedSubscript("stack")?.toString()
      var payload: [String: Any] = ["contextId": id, "message": message]
      if let stack = stack { payload["stack"] = stack }
      weakModule?.emit("jsc_error", payload)
    }

    // Single-dispatcher bridge (Pebble's rule — see JSCExperiment.swift).
    let dispatchBlock: @convention(block) (String, String, [Any]?) -> Any? = { iface, method, args in
      return JscBridge.handle(
        contextId: id,
        iface: iface,
        method: method,
        args: args,
        handle: weakHandle,
        module: weakModule)
    }
    ctx.setObject(dispatchBlock, forKeyedSubscript: "__dispatch" as NSString)

    // Polyfills: globalThis aliases, console, timers, fetch, BluetoothSdk, Foreground.
    handle.queue.sync {
      JscPolyfills.installAll(in: ctx, contextId: id, handle: handle, module: weakModule)
    }

    mapQueue.sync { contexts[id] = handle }
  }

  func destroy(id: String) {
    let handle: ContextHandle? = mapQueue.sync {
      let h = contexts.removeValue(forKey: id)
      return h
    }
    guard let h = handle else { return }
    h.queue.sync {
      for (_, t) in h.timers { t.cancel() }
      h.timers.removeAll()
    }
    // Drop refs — ARC releases ctx + vm after queue drains.
  }

  func destroyAll() {
    let ids = mapQueue.sync { Array(contexts.keys) }
    for id in ids { destroy(id: id) }
  }

  func evaluate(id: String, script: String) throws -> Any? {
    guard let h = handle(id: id) else { throw JscError.unknownId(id) }
    var thrown: String?
    var result: Any?
    h.queue.sync {
      let value = h.ctx.evaluateScript(script)
      // exceptionHandler already fires jsc_error; we still want to surface
      // the thrown value to the awaiter via a thrown Swift error.
      if let exc = h.ctx.exception {
        thrown = exc.toString() ?? "<unknown>"
        h.ctx.exception = nil
      } else if let value = value, !value.isUndefined, !value.isNull {
        result = value.toObject()
      }
    }
    if let t = thrown { throw JscError.scriptThrew(t) }
    return result
  }
}
