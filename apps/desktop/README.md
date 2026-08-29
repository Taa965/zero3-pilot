# Zero3 Pilot Desktop

`zero3-pilot` is the Windows-first native desktop shell for the local Zero3 Pilot Node.

- Uses a native Tao window and Wry/WebView2.
- Connects only to the loopback Node UI (`http://127.0.0.1:8790/` by default).
- Reuses an already-running Node when one is healthy.
- Otherwise starts the sibling `zero3-pilot-node.exe` (or `ZERO3_PILOT_NODE_BIN`) and waits for `/health` before opening the UI.
- On exit, it stops only the Node child it started; it never kills a pre-existing Node.
- `ZERO3_DESKTOP_SMOKE_MS` provides a bounded real-WebView smoke mode for Windows CI.

The product runtime itself lives in [`apps/node`](../node); the desktop process is deliberately a thin shell rather than a second agent runtime.

> Migration note: this Rust/WebView shell is now legacy. New desktop work belongs in [`apps/zero3-desktop`](../zero3-desktop), which is migrating to the pinned open-source Hermes Desktop Electron/React shell. Keep this path only for rollback and current installer compatibility until Desktop v3 clears its acceptance gates.
