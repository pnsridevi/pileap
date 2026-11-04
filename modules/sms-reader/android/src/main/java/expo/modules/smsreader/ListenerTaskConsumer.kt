package expo.modules.smsreader

import android.content.Context
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskConsumerInterface
import expo.modules.interfaces.taskManager.TaskExecutionCallback
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

// ─────────────────────────────────────────────────────────────────────────────
// ListenerTaskConsumer — [ADD — Nov 4]
//
// Connects the JS task "pileap-sms-listener-sync" (defined with
// TaskManager.defineTask in backgroundSync.ts) to native code, so
// ListenerSyncWorker can run it with no screen.
//
// This is the same mechanism expo-background-task uses for the hourly task
// (its BackgroundTaskConsumer): expo-task-manager stores the registration,
// recreates this consumer after the app is killed, and starts the app's JS
// headlessly when the task is executed. If the app is already running, the
// task runs in the live app instead.
//
// The constructor signature (Context, TaskManagerUtilsInterface) is
// required: expo-task-manager creates consumers by reflection.
// ─────────────────────────────────────────────────────────────────────────────

class ListenerTaskConsumer(context: Context?, taskManagerUtils: TaskManagerUtilsInterface?) :
  TaskConsumer(context, taskManagerUtils), TaskConsumerInterface {

  companion object {
    const val TASK_TYPE = "pileap-sms-listener"
  }

  private var task: TaskInterface? = null

  override fun taskType(): String = TASK_TYPE

  override fun didRegister(task: TaskInterface) {
    this.task = task
  }

  override fun didUnregister() {
    this.task = null
  }

  internal fun hasTask(): Boolean = task != null

  internal fun execute(callback: TaskExecutionCallback) {
    taskManagerUtils.executeTask(task, null, callback)
  }
}

/** Runs the registered JS listener task and waits for it to finish. */
internal object ListenerTaskRunner {
  // A sync normally takes a few seconds. WorkManager stops a job after
  // 10 minutes, so give up well before that.
  private const val TIMEOUT_MS = 4 * 60 * 1000L

  /**
   * Returns "finished", "timeout", "not_registered" (the app hasn't been
   * opened since this build was installed) or "no_task_service".
   */
  suspend fun run(context: Context): String {
    val service = TaskServiceProviderHelper.getTaskServiceImpl(context.applicationContext)
      ?: return "no_task_service"

    // In this app the scope key is the package name (same as
    // expo-background-task uses).
    val consumer = service.getTaskConsumers(context.packageName)
      .filterIsInstance<ListenerTaskConsumer>()
      .firstOrNull { it.hasTask() }
      ?: return "not_registered"

    val done = CompletableDeferred<Unit>()
    consumer.execute { done.complete(Unit) }

    return if (withTimeoutOrNull(TIMEOUT_MS) { done.await() } != null) "finished" else "timeout"
  }
}
