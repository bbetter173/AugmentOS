import ExpoModulesCore
import Foundation

public class JscModule: Module {
  static weak var shared: JscModule?

  public func definition() -> ModuleDefinition {
    Name("Jsc")

    Events("foreground_message", "jsc_console", "jsc_error")

    OnCreate {
      JscModule.shared = self
      JscRuntime.shared.bind(module: self)
    }

    OnDestroy {
      JscRuntime.shared.destroyAll()
      JscModule.shared = nil
    }

    AsyncFunction("createContext") { (id: String) in
      try JscRuntime.shared.create(id: id)
    }

    AsyncFunction("destroyContext") { (id: String) in
      JscRuntime.shared.destroy(id: id)
    }

    AsyncFunction("evaluate") { (id: String, script: String) -> Any? in
      try JscRuntime.shared.evaluate(id: id, script: script)
    }

    Function("listContexts") { () -> [String] in
      JscRuntime.shared.listIds()
    }
  }

  /// Internal: emit a typed event with a payload dict. Always called from
  /// JscRuntime/JscBridge — never directly from JS.
  func emit(_ name: String, _ payload: [String: Any]) {
    sendEvent(name, payload)
  }
}
