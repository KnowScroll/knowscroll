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
