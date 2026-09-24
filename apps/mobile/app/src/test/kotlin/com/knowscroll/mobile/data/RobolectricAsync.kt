package com.knowscroll.mobile.data

/**
 * Pumps Robolectric's (paused by default) main looper while a real background thread finishes
 * real IO, until [condition] holds or [timeoutMs] elapses. `viewModelScope` dispatches its
 * `Dispatchers.Main.immediate` continuations onto that looper, so a ViewModel's `StateFlow`
 * update after a suspend call is otherwise never delivered inside a Robolectric JVM test.
 */
fun awaitUntil(timeoutMs: Long = 5000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        if (condition()) return
        check(System.currentTimeMillis() < deadline) { "Timed out waiting for the expected state" }
        Thread.sleep(10)
    }
}
