interface InspectorDrawerProps {
  onClose: () => void
}

export function InspectorDrawer({ onClose }: InspectorDrawerProps) {
  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-(--ui-border) bg-(--ui-pane-background)">
      <div className="flex h-12 items-center justify-between border-b border-(--ui-border) px-4">
        <div className="font-medium">Inspector</div>
        <button onClick={onClose} className="text-sm text-(--ui-text-tertiary) hover:text-foreground">
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm text-(--ui-text-secondary)">
        Contextual details will appear here.
      </div>
    </div>
  )
}
