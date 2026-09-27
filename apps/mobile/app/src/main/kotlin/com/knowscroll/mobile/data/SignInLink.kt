package com.knowscroll.mobile.data

import java.net.URI
import java.net.URLDecoder

/**
 * #135 (ADR-0034 section 6): extract the sign-in token from a pasted magic-link URL. The link is
 * either `<KS_WEB_ORIGIN>/sign-in#token=<token>` (a web origin is configured) or
 * `<api>/v1/auth/confirm?token=<token>` (it is not) -- this never assumes which one, checking the
 * fragment first and falling back to the query string. Anything else -- not a URL, an
 * unrecognised scheme, no `token` parameter, or an empty one -- is rejected outright: a malformed
 * paste must never be silently treated as a usable token. Pure and side-effect free so it is
 * exercised directly by a JVM test.
 */
fun parseSignInToken(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
    if (uri.scheme?.lowercase() !in setOf("http", "https")) return null
    uri.rawFragment?.let(::tokenFromQueryLike)?.let { return it }
    return uri.rawQuery?.let(::tokenFromQueryLike)
}

/**
 * #168 (ADR-0047): the sign-in link an opened App Link carries, or `null` for anything that must
 * not be put in front of the reader. Any app can send the activity a link, so only exactly
 * `https://<appLinksHost>/sign-in` -- default port, no user info, a token [parseSignInToken]
 * accepts -- is taken, and never from a relaunch out of Recents, which re-delivers the intent that
 * first started the activity. The whole link is returned: it only fills the paste field, since a
 * link opens the confirmation, never the consumption (ADR-0026 section 3).
 */
fun receivedSignInLink(data: String?, appLinksHost: String, launchedFromHistory: Boolean): String? {
    if (data == null || launchedFromHistory) return null
    val uri = runCatching { URI(data) }.getOrNull() ?: return null
    val exact = uri.scheme == "https" && uri.host.equals(appLinksHost, ignoreCase = true) &&
        uri.port == -1 && uri.rawUserInfo == null && uri.rawPath == "/sign-in"
    return data.takeIf { exact && parseSignInToken(it) != null }
}

private fun tokenFromQueryLike(part: String): String? {
    for (pair in part.split("&")) {
        val separator = pair.indexOf('=')
        if (separator <= 0) continue
        if (pair.substring(0, separator) != "token") continue
        val rawValue = pair.substring(separator + 1)
        if (rawValue.isBlank()) return null
        return runCatching { URLDecoder.decode(rawValue, "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
    }
    return null
}
