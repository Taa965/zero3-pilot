import { App } from './App'
import { HandoffDock } from './HandoffDock'
import { ProjectDock } from './ProjectDock'
import { TaskDock } from './TaskDock'

export function ProductApp() {
  return (
    <>
      <App />
      <HandoffDock />
      <ProjectDock />
      <TaskDock />
    </>
  )
}
