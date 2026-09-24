package com.knowscroll.mobile.data

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #135: the sign-in and privacy-lifecycle wire shapes, over the same raw-socket fixture pattern
 * the rest of `data/` already uses (`WhyTest`, `CableTransportTest`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AccountApiTest {
    @Test
    fun magicLinkRequestCarriesTheEmailAndNeedsNoCredential() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(202 to """{"status":"requested"}""")
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1)
            api.requestMagicLink("owner@knowscroll.test")
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("POST /v1/auth/magic-link "))
            assertEquals("owner@knowscroll.test", JSONObject(request.body).getString("email"))
        }
    }

    @Test
    fun sessionConsumptionParsesEveryField() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"sessionToken":"tok-1","sessionId":"s1","deviceId":"d1","universeId":"u1",
                    "privacyEpoch":3,"expiresAt":"2026-10-01T00:00:00Z","accountId":"a1","origin":"magic_link"}"""
            )
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1)
            val receipt = api.consumeSignInToken("raw-token")
            server.join()
            val request = server.requests.single()
            assertTrue(request.requestLine.startsWith("POST /v1/auth/session "))
            assertEquals("raw-token", JSONObject(request.body).getString("token"))
            assertEquals("tok-1", receipt.sessionToken)
            assertEquals("s1", receipt.sessionId)
            assertEquals("u1", receipt.universeId)
            assertEquals(3L, receipt.privacyEpoch)
            assertEquals("a1", receipt.accountId)
            assertEquals("magic_link", receipt.origin)
        }
    }

    @Test
    fun sessionConsumptionRefusalIsAGenuine401() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(401 to """{"error":"Unauthorized"}""")
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1)
            val error = runCatching { api.consumeSignInToken("dead-token") }.exceptionOrNull()
            assertTrue(error is ApiException.Server && error.statusCode == 401)
        }
    }

    @Test
    fun pauseAndResumeSendTheirRequestEnvelopeAndParseTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(
                200 to """{"receiptId":"r1","action":"pause","privacyEpoch":2,"recordingPausedAt":"2026-09-24T00:00:00Z","appliedAt":"2026-09-24T00:00:00Z"}""",
                200 to """{"receiptId":"r2","action":"resume","privacyEpoch":2,"recordingPausedAt":null,"appliedAt":"2026-09-24T01:00:00Z"}""",
            )
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1)
            val paused = api.pauseRecording(PrivacyLifecycleRequest("req-1", 2))
            val resumed = api.resumeRecording(PrivacyLifecycleRequest("req-2", 2))
            server.join()
            assertEquals("pause", paused.action)
            assertEquals("2026-09-24T00:00:00Z", paused.recordingPausedAt)
            assertEquals("resume", resumed.action)
            assertEquals(null, resumed.recordingPausedAt)
            val (first, second) = server.requests
            assertTrue(first.requestLine.startsWith("POST /v1/privacy/pause "))
            assertEquals("req-1", JSONObject(first.body).getString("requestId"))
            assertEquals(2, JSONObject(first.body).getInt("expectedPrivacyEpoch"))
            assertTrue(second.requestLine.startsWith("POST /v1/privacy/resume "))
        }
    }

    @Test
    fun exportHandsBackTheServerBodyVerbatimAsText() = runBlocking {
        TestHttpServer.open().use { server ->
            val body = """{"receiptId":"r3","privacyEpoch":2,"exportedAt":"2026-09-24T00:00:00Z","rowCounts":{"decisions":1}}"""
            server.serve(200 to body)
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1)
            val exported = api.exportUniverse(PrivacyLifecycleRequest("req-3", 2))
            server.join()
            val reparsed = JSONObject(exported)
            assertEquals("r3", reparsed.getString("receiptId"))
            assertEquals(1, reparsed.getJSONObject("rowCounts").getInt("decisions"))
        }
    }

    @Test
    fun resetSendsItsLiteralAndParsesTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"receiptId":"r4","epochBefore":2,"epochAfter":3,"sessionsRevoked":2,"resetAt":"2026-09-24T00:00:00Z"}""")
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1)
            val receipt = api.resetPersonalUniverse(PrivacyResetRequest("req-4", 2))
            server.join()
            val request = server.requests.single()
            assertEquals("reset-personal-universe", JSONObject(request.body).getString("confirmation"))
            assertEquals(3L, receipt.epochAfter)
            assertEquals(2L, receipt.sessionsRevoked)
        }
    }

    @Test
    fun deleteAccountSendsItsOwnLiteralAndParsesTheReceipt() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"receiptId":"r5","epochBefore":2,"epochAfter":3,"sessionsDeleted":2,"deletedAt":"2026-09-24T00:00:00Z"}""")
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1)
            val receipt = api.deleteAccount(AccountDeletionRequest("req-5", 2))
            server.join()
            val request = server.requests.single()
            assertEquals("delete-my-account-and-history", JSONObject(request.body).getString("confirmation"))
            assertEquals(3L, receipt.epochAfter)
            assertEquals(2L, receipt.sessionsDeleted)
        }
    }

    @Test
    fun aGenuine401OnAnAuthenticatedCallReportsUnauthorizedExactlyOnce() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(401 to """{"error":"Unauthorized"}""")
            var reports = 0
            val api = ApiClient(server.baseUrl, "fixture-token", maxAttempts = 1, onUnauthorized = { reports++ })
            val error = runCatching { api.pauseRecording(PrivacyLifecycleRequest("req-6", 2)) }.exceptionOrNull()
            assertTrue(error is ApiException.Server && error.statusCode == 401)
            assertEquals(1, reports)
        }
    }

    @Test
    fun magicLinkAndSessionRoutesNeverReportUnauthorizedEvenOnA401() = runBlocking {
        // These routes send no credential at all (`requiresAuth = false`); their own 401 is a
        // sign-in refusal, never "this device's session died".
        TestHttpServer.open().use { server ->
            server.serve(401 to """{"error":"Unauthorized"}""")
            var reports = 0
            val api = ApiClient(server.baseUrl, "", maxAttempts = 1, onUnauthorized = { reports++ })
            runCatching { api.consumeSignInToken("dead") }
            assertEquals(0, reports)
        }
    }

    @Test
    fun theResolvedCredentialProviderTokenIsWhatIsActuallySent() = runBlocking {
        TestHttpServer.open().use { server ->
            server.serve(200 to """{"universeId":"u1","revision":1,"privacyEpoch":0,"traces":[],"capabilities":{}}""")
            var calls = 0
            val provider = CredentialProvider { calls++; "resolved-token" }
            val api = ApiClient(server.baseUrl, "unused-fallback", maxAttempts = 1, credential = provider)
            api.getUniverse()
            server.join()
            assertTrue("credential provider must be consulted for an authenticated request", calls >= 1)
        }
    }

    @Test
    fun aNullCredentialMeansNoCredentialAtAllRatherThanTheFallbackToken() = runBlocking {
        val provider = CredentialProvider { null }
        val api = ApiClient("http://127.0.0.1:1", "unused-fallback", maxAttempts = 1, credential = provider)
        val error = runCatching { api.getUniverse() }.exceptionOrNull()
        assertTrue(error is ApiException.MissingToken)
    }
}
