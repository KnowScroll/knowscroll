package com.knowscroll.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #135: the exact credential-selection rule ApiClient/ReelScreen/AppViewModel all rely on. */
class CredentialTest {
    @Test
    fun theVaultTokenWinsWheneverItIsPresentAndNonBlank() {
        assertEquals("vault-token", selectCredential("vault-token", "dev-token", isDebugBuild = true))
        assertEquals("vault-token", selectCredential("vault-token", "dev-token", isDebugBuild = false))
        assertEquals("vault-token", selectCredential("vault-token", "", isDebugBuild = true))
    }

    @Test
    fun aBlankVaultTokenIsTreatedAsAbsent() {
        assertEquals("dev-token", selectCredential("", "dev-token", isDebugBuild = true))
        assertEquals("dev-token", selectCredential("   ", "dev-token", isDebugBuild = true))
    }

    @Test
    fun theDevelopmentTokenIsUsedOnlyInADebugBuildAndOnlyWhenNonBlank() {
        assertEquals("dev-token", selectCredential(null, "dev-token", isDebugBuild = true))
        assertNull(selectCredential(null, "dev-token", isDebugBuild = false))
        assertNull(selectCredential(null, "", isDebugBuild = true))
        assertNull(selectCredential(null, "", isDebugBuild = false))
    }

    @Test
    fun noCredentialWhenNeitherIsAvailable() {
        assertNull(selectCredential(null, "", isDebugBuild = true))
    }

    @Test
    fun vaultCredentialProviderReadsTheVaultFreshOnEveryCall() {
        val vault = FakeSessionVault()
        val provider = VaultCredentialProvider(vault, "dev-token", isDebugBuild = true)
        assertEquals("dev-token", provider.currentToken())
        vault.writeToken("real-session-token")
        assertEquals("real-session-token", provider.currentToken())
        vault.clear()
        assertEquals("dev-token", provider.currentToken())
    }

    @Test
    fun vaultCredentialProviderNeverFallsBackInARelease() {
        val vault = FakeSessionVault()
        val provider = VaultCredentialProvider(vault, "dev-token", isDebugBuild = false)
        assertNull(provider.currentToken())
        vault.writeToken("real-session-token")
        assertEquals("real-session-token", provider.currentToken())
    }
}
