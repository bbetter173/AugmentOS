package com.mentra.jsc

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub for @mentra/jsc.
 *
 * The full JSContext-based runtime lives only on iOS (see ios/Source/JscRuntime.swift).
 * On Android we expose the same TS surface but every call rejects, so imports
 * type-check and consumers can no-op feature-detect via `try { await Jsc.createContext(...) }`.
 */
class JscModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Jsc")

    Events("foreground_message", "jsc_console", "jsc_error")

    AsyncFunction("createContext") { _: String ->
      throw NotSupportedException()
    }

    AsyncFunction("destroyContext") { _: String ->
      // No-op: nothing to destroy on Android.
    }

    AsyncFunction("evaluate") { _: String, _: String ->
      throw NotSupportedException()
    }

    Function("listContexts") {
      emptyList<String>()
    }
  }
}

private class NotSupportedException :
  CodedException("Jsc: this module is iOS only; no JSContext runtime on Android.")
