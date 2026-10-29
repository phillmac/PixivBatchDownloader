import { TaskList } from './DownloadType'
import { diagnosticSample } from './DiagnosticSerialization'

/** 仅在完整诊断时扫描队列；优先保留活动项，再保留最近项，不克隆整个队列。 */
export function downloadQueueSnapshot(
  states: readonly number[],
  tasks: TaskList
) {
  const activeStates: Record<string, unknown>[] = []
  const recentStates: Record<string, unknown>[] = []
  const activeTasks: Record<string, unknown>[] = []
  const recentTasks: Record<string, unknown>[] = []
  let taskTotal = 0
  const counts = {
    total: states.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
  }
  for (let index = 0; index < states.length; index++) {
    const state = states[index]
    if (state === -1) counts.pending++
    else if (state === 0) counts.inProgress++
    else if (state === 1) counts.completed++
    if (state === 0 && activeStates.length < 120)
      activeStates.push({ index, state })
    else {
      recentStates.push({ index, state })
      if (recentStates.length > 120) recentStates.shift()
    }
  }
  for (const id in tasks) {
    if (!Object.prototype.hasOwnProperty.call(tasks, id)) continue
    const task = tasks[id]
    taskTotal++
    if (states[task.index] === 0 && activeTasks.length < 120) {
      activeTasks.push({ id, ...task })
    } else {
      recentTasks.push({ id, ...task })
      if (recentTasks.length > 120) recentTasks.shift()
    }
  }
  const stateSample = diagnosticSample(
    [...activeStates, ...recentStates],
    states.length,
    12 * 1024
  )
  const taskSample = diagnosticSample(
    [...activeTasks, ...recentTasks.reverse()],
    taskTotal,
    12 * 1024
  )
  return {
    downloadStateSummary: counts,
    downloadStates: stateSample.items,
    downloadStatesTotal: stateSample.total,
    downloadStatesOmitted: stateSample.omitted,
    taskList: taskSample.items,
    taskListTotal: taskSample.total,
    taskListOmitted: taskSample.omitted,
  }
}
