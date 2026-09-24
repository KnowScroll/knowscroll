package com.knowscroll.mobile.data

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** Resolves the bearer token to send with an authenticated request, or `null` for none. */
fun interface CredentialProvider {
    fun currentToken(): String?
}

/**
 * #135: the signed-in vault token wins; otherwise, only in a debug build, a non-blank development
 * token; otherwise no credential at all. Kept free of any Android/`BuildConfig` reference so a
 * JVM test exercises the exact decision the app makes, for every combination.
 */
fun selectCredential(vaultToken: String?, developmentToken: String, isDebugBuild: Boolean): String? {
    vaultToken?.takeIf { it.isNotBlank() }?.let { return it }
    return developmentToken.takeIf { isDebugBuild && it.isNotBlank() }
}

/** Reads the vault fresh on every call. A sign-in or sign-out from any [SessionVault] instance
 * pointed at the same app is visible to the very next request -- no extra wiring between the
 * reader's `ApiClient` and the account screen's is needed. */
class VaultCredentialProvider(
    private val vault: SessionVault,
    private val developmentToken: String,
    private val isDebugBuild: Boolean,
) : CredentialProvider {
    override fun currentToken(): String? = selectCredential(vault.readToken(), developmentToken, isDebugBuild)
}

/**
 * Process-wide signal that an authenticated request just received a genuine 401 (#135). Every
 * `ApiClient` reports here by default (see [ApiClient]'s `onUnauthorized` parameter); the account
 * screen is the only listener, and it only acts when its own vault still holds a token -- a 401
 * against a development token (no vault entry) is a no-op, so existing debug/journey sign-out
 * behaviour (#91) is unaffected. Not persisted: process death always re-derives auth state from
 * the vault, never from this signal.
 *
 * A [SharedFlow] with `replay = 0`, deliberately not a [kotlinx.coroutines.flow.StateFlow]: a
 * `StateFlow` replays its latest value to every *new* collector, so a listener created after an
 * earlier, already-handled 401 (e.g. a view model recreated later in the same process, or -- the
 * way this bit a first version of this signal -- a fresh instance in a later test in the same JVM)
 * would immediately replay that stale event and sign a perfectly valid new session out. A `replay
 * = 0` `SharedFlow` only ever delivers events emitted *after* a collector subscribes.
 */
object SessionInvalidation {
    private val _events = MutableSharedFlow<Unit>(replay = 0, extraBufferCapacity = 8)
    val events: SharedFlow<Unit> = _events
    fun reportUnauthorized() {
        _events.tryEmit(Unit)
    }
}
