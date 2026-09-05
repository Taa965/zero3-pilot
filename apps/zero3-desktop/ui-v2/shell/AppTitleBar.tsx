export function AppTitleBar() {
  return (
    <div
      className="flex h-10 shrink-0 items-center justify-between border-b border-(--ui-border) [-webkit-app-region:drag]"
      // The window is frameless (`titleBarStyle: 'hidden'`), so the drag band
      // has to come from the renderer. The native window controls sit inside
      // the same strip -- on Windows to the right, on macOS as traffic lights
      // to the left -- and `env(titlebar-area-*)` is the only source that
      // reports where they actually are. Padding derived from it keeps the
      // search trigger clear of them at any window width or DPI scale.
      style={{
        paddingLeft: 'calc(env(titlebar-area-x, 0px) + 1rem)',
        paddingRight: 'calc(100% - env(titlebar-area-width, 100%) - env(titlebar-area-x, 0px) + 0.5rem)'
      }}
    >
      <div className="flex items-center gap-2 font-medium">
        <span>Zero3 Pilot</span>
      </div>
      <div className="flex items-center gap-4 [-webkit-app-region:no-drag]">
        {/* Global Search / Command Palette Trigger */}
        <button className="flex h-6 items-center rounded-md bg-(--ui-control-background) px-2 text-xs text-(--ui-text-tertiary)">
          Search or jump to...
        </button>
      </div>
    </div>
  )
}
