import Foundation
import JavaScriptCore

/// Single entry point for every native call made from inside a JSContext.
/// Lives behind the `__dispatch` and `__nativeBridge[Async]` JS shims; never
/// called directly from JS.
///
/// Routing by `iface`:
///   - "bluetooth": delegates to JscBridgeBluetoothRouter (host-registered handlers)
///   - "foreground": emits foreground_message events
///   - "console":    emits jsc_console events
///   - "noop":       returns NSNull() (used by the JSCExperiment-style workload)
enum JscBridge {
  static func handle(
    contextId: String,
    iface: String,
    method: String,
    args: [Any]?,
    handle: JscRuntime.ContextHandle?,
    module: JscModule?
  ) -> Any? {
    switch iface {
    case "bluetooth":
      return JscBridgeBluetoothRouter.shared.call(method: method, args: args)
    case "foreground":
      if method == "sendMessage" {
        let payload = args?.first ?? NSNull()
        module?.emit("foreground_message", [
          "contextId": contextId,
          "data": payload,
        ])
      }
      return NSNull()
    case "console":
      module?.emit("jsc_console", [
        "contextId": contextId,
        "level": method,
        "args": args ?? [],
      ])
      return NSNull()
    case "noop":
      return NSNull()
    default:
      return NSNull()
    }
  }
}

/// Holds the registered native handlers for `BluetoothSdk.<method>()` calls
/// made from inside a JSContext. The host app registers handlers at startup
/// (e.g. from `mobile/ios/.../JscWiring.swift`) so this module does NOT
/// have a hard compile-time dependency on `@mentra/bluetooth-sdk`.
///
/// Handlers run on a background queue; results are routed back to JS by
/// JscPolyfills.__nativeBridgeAsync.
public final class JscBridgeBluetoothRouter {
  public static let shared = JscBridgeBluetoothRouter()

  public typealias Handler = (_ args: [Any]?) -> Any?

  private let lock = NSLock()
  private var handlers: [String: Handler] = [:]

  /// Register a handler for a BluetoothSdk method. Idempotent; later
  /// registrations replace earlier ones.
  public func register(method: String, handler: @escaping Handler) {
    lock.lock(); defer { lock.unlock() }
    handlers[method] = handler
  }

  /// Remove a handler. Calls to that method will then resolve with `null`.
  public func unregister(method: String) {
    lock.lock(); defer { lock.unlock() }
    handlers.removeValue(forKey: method)
  }

  /// Snapshot of registered methods. Useful for debugging from JS via
  /// `BluetoothSdk.__listMethods()` if the host adds that handler.
  public func registeredMethods() -> [String] {
    lock.lock(); defer { lock.unlock() }
    return Array(handlers.keys)
  }

  fileprivate func call(method: String, args: [Any]?) -> Any? {
    lock.lock()
    let handler = handlers[method]
    lock.unlock()
    guard let handler = handler else { return NSNull() }
    return handler(args)
  }
}

// MARK: - URLSession-backed fetch

/// Implementation of `__nativeFetch`. Buffers the response body in memory
/// (no streaming in v1) and calls back into JS on the context's queue.
enum JscFetch {
  private static let session: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.waitsForConnectivity = true
    cfg.timeoutIntervalForRequest = 30
    return URLSession(configuration: cfg)
  }()

  static func perform(
    token: Int,
    url: String,
    initJson: String,
    handle: JscRuntime.ContextHandle?
  ) {
    guard let h = handle else { return }
    guard let u = URL(string: url) else {
      resolve(handle: h, token: token, error: "invalid url: \(url)")
      return
    }

    // Parse init: method, headers, body. Anything not recognized is ignored.
    var req = URLRequest(url: u)
    req.httpMethod = "GET"
    if let data = initJson.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      if let m = obj["method"] as? String { req.httpMethod = m.uppercased() }
      if let headers = obj["headers"] as? [String: Any] {
        for (k, v) in headers {
          req.setValue("\(v)", forHTTPHeaderField: k)
        }
      }
      if let body = obj["body"] as? String {
        req.httpBody = body.data(using: .utf8)
      }
    }

    let task = session.dataTask(with: req) { data, response, error in
      if let error = error {
        resolve(handle: h, token: token, error: error.localizedDescription)
        return
      }
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 0
      let ok = (200..<300).contains(status)
      var headers: [String: String] = [:]
      http?.allHeaderFields.forEach { k, v in
        headers["\(k)"] = "\(v)"
      }
      let body = (data.flatMap { String(data: $0, encoding: .utf8) }) ?? ""
      resolve(
        handle: h, token: token,
        ok: ok, status: status, statusText: HTTPURLResponse.localizedString(forStatusCode: status),
        headers: headers, body: body, error: nil)
    }
    task.resume()
  }

  private static func resolve(
    handle: JscRuntime.ContextHandle,
    token: Int,
    ok: Bool = false,
    status: Int = 0,
    statusText: String = "",
    headers: [String: String] = [:],
    body: String = "",
    error: String? = nil
  ) {
    handle.queue.async {
      // Build a JS call with JSON-encoded args to dodge string escaping pain.
      let payload: [String: Any] = [
        "token": token,
        "ok": ok,
        "status": status,
        "statusText": statusText,
        "headers": headers,
        "body": body,
        "err": error as Any? ?? NSNull(),
      ]
      let json = JscJson.encode(payload)
      let script = """
        (function () {
          var p = \(json);
          globalThis.__resolveFetch(p.token, p.ok, p.status, p.statusText, p.headers, p.body, p.err);
        })();
        """
      handle.ctx.evaluateScript(script)
    }
  }
}

// MARK: - JSON helpers

enum JscJson {
  /// Encode an arbitrary value (NSNull/Number/String/Array/Dictionary or
  /// any Swift type bridged from JS) to a JS literal. Never throws — falls
  /// back to "null" on failure.
  static func encode(_ value: Any?) -> String {
    let normalized = normalize(value)
    if let data = try? JSONSerialization.data(
      withJSONObject: normalized, options: [.fragmentsAllowed])
    {
      return String(data: data, encoding: .utf8) ?? "null"
    }
    return "null"
  }

  /// JSONSerialization rejects NaN/Infinity and some custom types. Coerce
  /// what we can; anything else becomes its string description.
  private static func normalize(_ value: Any?) -> Any {
    guard let value = value else { return NSNull() }
    if value is NSNull { return NSNull() }
    if let d = value as? Double, !d.isFinite { return NSNull() }
    if let arr = value as? [Any] { return arr.map { normalize($0) } }
    if let dict = value as? [String: Any] {
      var out: [String: Any] = [:]
      for (k, v) in dict { out[k] = normalize(v) }
      return out
    }
    if value is Bool || value is Int || value is Double || value is String {
      return value
    }
    if let n = value as? NSNumber { return n }
    return "\(value)"
  }
}
