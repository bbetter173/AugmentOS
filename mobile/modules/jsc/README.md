# @mentra/jsc

Isolated JavaScriptCore runtime for MentraOS. Each context gets its own
`JSVirtualMachine` (full heap isolation), polyfills for `fetch`, timers,
`console`, and a bridge into native services (`BluetoothSdk`, `Foreground`).

iOS only. Android exports a stub that rejects on every call.

## Usage

```ts
import Jsc from "@mentra/jsc"

await Jsc.createContext("demo")

await Jsc.evaluate(
  "demo",
  `
    console.log('hello from jsc');
    Foreground.sendMessage({ kind: 'ready' });
    setTimeout(() => Foreground.sendMessage({ kind: 'tick' }), 1000);
    fetch('https://httpbin.org/get')
      .then(r => r.json())
      .then(j => Foreground.sendMessage({ kind: 'fetch', j }));
  `,
)

const unsub = Jsc.onForegroundMessage(({contextId, data}) => {
  console.log("from jsc:", contextId, data)
})

// later...
unsub()
await Jsc.destroyContext("demo")
```

## Wiring BluetoothSdk

The `BluetoothSdk` proxy inside the JS context routes every method call to a
native handler registered at app startup. To avoid a circular dependency
between `@mentra/jsc` and `@mentra/bluetooth-sdk`, the host app registers
handlers via `JscBridgeBluetoothRouter.register(method:handler:)` (Swift,
called from app init) — see `mobile/ios/.../JscWiring.swift`.

If a method is not registered, calls into `BluetoothSdk.foo()` resolve with
`null`.
