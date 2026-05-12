import Foundation
import JavaScriptCore

/// Installs the standard JS surface inside a fresh JSContext.
/// All polyfills route through the single `__dispatch` bridge installed by
/// JscRuntime — no per-method JSValue properties, per Pebble's GC/ARC rule.
enum JscPolyfills {
  static func installAll(
    in ctx: JSContext,
    contextId: String,
    handle: JscRuntime.ContextHandle,
    module: JscModule?
  ) {
    installNativeHelpers(in: ctx, contextId: contextId, handle: handle, module: module)
    ctx.evaluateScript(Self.preamble)
  }

  /// Native blocks called *by* the JS preamble. These are the only blocks
  /// bound directly to JSValue properties; they all use plain JSON-able
  /// types (no JSValue closures stored long-term).
  private static func installNativeHelpers(
    in ctx: JSContext,
    contextId: String,
    handle: JscRuntime.ContextHandle,
    module: JscModule?
  ) {
    weak var weakHandle = handle
    weak var weakModule = module

    // __nativeSetTimer(kind, ms, token) — kind 0=timeout, 1=interval. Schedules
    // a DispatchSourceTimer; on fire, evaluates __fireTimer(token).
    let setTimer: @convention(block) (Int, Double, Int) -> Void = { kind, ms, token in
      guard let h = weakHandle else { return }
      let timer = DispatchSource.makeTimerSource(queue: h.queue)
      let interval = max(0.001, ms / 1000.0)
      if kind == 1 {
        timer.schedule(deadline: .now() + interval, repeating: interval)
      } else {
        timer.schedule(deadline: .now() + interval)
      }
      timer.setEventHandler { [weak h] in
        guard let h = h else { return }
        h.ctx.evaluateScript("globalThis.__fireTimer(\(token), \(kind))")
        if kind == 0 {
          // One-shot: remove from map.
          if let t = h.timers.removeValue(forKey: token) {
            t.cancel()
          }
        }
      }
      h.timers[token] = timer
      timer.resume()
    }
    ctx.setObject(setTimer, forKeyedSubscript: "__nativeSetTimer" as NSString)

    let clearTimer: @convention(block) (Int) -> Void = { token in
      guard let h = weakHandle else { return }
      h.queue.async {
        if let t = h.timers.removeValue(forKey: token) {
          t.cancel()
        }
      }
    }
    ctx.setObject(clearTimer, forKeyedSubscript: "__nativeClearTimer" as NSString)

    // __nativeNextTimerId — atomic-ish id allocator on the context queue.
    let nextTimerId: @convention(block) () -> Int = {
      guard let h = weakHandle else { return 0 }
      let id = h.nextTimerId
      h.nextTimerId += 1
      return id
    }
    ctx.setObject(nextTimerId, forKeyedSubscript: "__nativeNextTimerId" as NSString)

    // __nativeFetch(token, url, initJson) — kicks off a URLSession request.
    // Resolves the JS-side promise via __resolveFetch(token, ...).
    let fetchBlock: @convention(block) (Int, String, String) -> Void = { token, url, initJson in
      JscFetch.perform(
        token: token,
        url: url,
        initJson: initJson,
        handle: weakHandle)
    }
    ctx.setObject(fetchBlock, forKeyedSubscript: "__nativeFetch" as NSString)

    // __nativeBridge(iface, method, args) — sync side-effect bridge for
    // console / Foreground / BluetoothSdk one-way calls. (For BluetoothSdk
    // calls that need a Promise, JS uses __nativeBridgeAsync.)
    let bridgeSync: @convention(block) (String, String, [Any]?) -> Any? = { iface, method, args in
      return JscBridge.handle(
        contextId: contextId,
        iface: iface,
        method: method,
        args: args,
        handle: weakHandle,
        module: weakModule)
    }
    ctx.setObject(bridgeSync, forKeyedSubscript: "__nativeBridge" as NSString)

    // __nativeBridgeAsync(token, iface, method, args) — same routing, but
    // the result is delivered back via __resolveBridge(token, ok, value, err).
    let bridgeAsync: @convention(block) (Int, String, String, [Any]?) -> Void = {
      token, iface, method, args in
      DispatchQueue.global(qos: .userInitiated).async {
        let result = JscBridge.handle(
          contextId: contextId,
          iface: iface,
          method: method,
          args: args,
          handle: weakHandle,
          module: weakModule)
        guard let h = weakHandle else { return }
        h.queue.async {
          let json = JscJson.encode(result)
          let safe = json.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
          h.ctx.evaluateScript("globalThis.__resolveBridge(\(token), true, JSON.parse('\(safe)'), null)")
        }
      }
    }
    ctx.setObject(bridgeAsync, forKeyedSubscript: "__nativeBridgeAsync" as NSString)
  }

  /// JS preamble — defines console, timers, fetch, BluetoothSdk, Foreground,
  /// globalThis aliases. Evaluated immediately after native helpers install.
  /// Keep this self-contained and side-effect-free except for the global
  /// assignments below.
  private static let preamble: String = #"""
  (function () {
    var g = (typeof globalThis !== 'undefined') ? globalThis : this;
    g.self = g;
    g.global = g;

    // ---- console ----
    function consoleArgs(args) {
      var out = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a && typeof a === 'object') {
          try { out.push(JSON.parse(JSON.stringify(a))); }
          catch (_) { out.push(String(a)); }
        } else {
          out.push(a);
        }
      }
      return out;
    }
    g.console = {
      log:   function () { __nativeBridge('console', 'log',   consoleArgs(arguments)); },
      warn:  function () { __nativeBridge('console', 'warn',  consoleArgs(arguments)); },
      error: function () { __nativeBridge('console', 'error', consoleArgs(arguments)); },
      info:  function () { __nativeBridge('console', 'log',   consoleArgs(arguments)); },
      debug: function () { __nativeBridge('console', 'log',   consoleArgs(arguments)); }
    };

    // ---- timers ----
    var _timerCallbacks = new Map();
    g.__fireTimer = function (token, kind) {
      var fn = _timerCallbacks.get(token);
      if (!fn) return;
      if (kind === 0) _timerCallbacks.delete(token);
      try { fn(); } catch (e) { console.error('timer threw:', e && e.message ? e.message : String(e)); }
    };
    g.setTimeout = function (fn, ms) {
      var id = __nativeNextTimerId();
      _timerCallbacks.set(id, fn);
      __nativeSetTimer(0, ms || 0, id);
      return id;
    };
    g.setInterval = function (fn, ms) {
      var id = __nativeNextTimerId();
      _timerCallbacks.set(id, fn);
      __nativeSetTimer(1, ms || 0, id);
      return id;
    };
    g.clearTimeout = function (id) {
      _timerCallbacks.delete(id);
      __nativeClearTimer(id);
    };
    g.clearInterval = g.clearTimeout;

    // ---- fetch ----
    var _fetchPending = new Map();
    var _fetchToken = 1;
    g.__resolveFetch = function (token, ok, status, statusText, headers, body, err) {
      var p = _fetchPending.get(token);
      if (!p) return;
      _fetchPending.delete(token);
      if (err) { p.rej(new Error(err)); return; }
      var bodyText = body == null ? '' : String(body);
      p.res({
        ok: !!ok,
        status: status || 0,
        statusText: statusText || '',
        headers: headers || {},
        text:   function () { return Promise.resolve(bodyText); },
        json:   function () { return Promise.resolve(JSON.parse(bodyText)); }
      });
    };
    g.fetch = function (url, init) {
      return new Promise(function (res, rej) {
        var token = _fetchToken++;
        _fetchPending.set(token, { res: res, rej: rej });
        try {
          __nativeFetch(token, String(url), JSON.stringify(init || {}));
        } catch (e) {
          _fetchPending.delete(token);
          rej(e);
        }
      });
    };

    // ---- async bridge (BluetoothSdk Promises) ----
    var _bridgePending = new Map();
    var _bridgeToken = 1;
    g.__resolveBridge = function (token, ok, value, err) {
      var p = _bridgePending.get(token);
      if (!p) return;
      _bridgePending.delete(token);
      if (!ok || err) p.rej(new Error(err || 'bridge error'));
      else p.res(value);
    };
    function asyncCall(iface, method, args) {
      return new Promise(function (res, rej) {
        var token = _bridgeToken++;
        _bridgePending.set(token, { res: res, rej: rej });
        try { __nativeBridgeAsync(token, iface, method, args); }
        catch (e) { _bridgePending.delete(token); rej(e); }
      });
    }

    // ---- BluetoothSdk proxy ----
    // Lazy: every property access returns a function that calls into the
    // bridge. Mirrors mobile/modules/bluetooth-sdk/src/BluetoothSdkModule.ts.
    g.BluetoothSdk = new Proxy({}, {
      get: function (_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          return asyncCall('bluetooth', prop, args);
        };
      }
    });

    // ---- Foreground ----
    g.Foreground = {
      sendMessage: function (data) {
        __nativeBridge('foreground', 'sendMessage', [data == null ? null : data]);
      }
    };
  })();
  """#
}
