package com.knowscroll.mobile.data

/** In-memory [SessionVault] for JVM tests: no AndroidKeyStore, no SharedPreferences. */
class FakeSessionVault(initial: String? = null) : SessionVault {
    private var token: String? = initial

    override fun readToken(): String? = token

    override fun writeToken(token: String) {
        this.token = token
    }

    override fun clear() {
        token = null
    }
}
