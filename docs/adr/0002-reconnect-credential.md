# Reconnect a dropped client with a single-use credential

## Context

A frontend restart, such as a redeploy, resets every client connection. The 15595 client never reconnects to Battle.net itself: it expects its Battle.net module to report the service as lost, reconnect in the background and report it as recovered. The compatibility DLL could not do that. Logon goes through the web challenge with the player's password, the DLL discards both the password and the login ticket immediately, and a login ticket is bound to its original connection and address and expires within minutes.

## Decision

After logon, a client may call `AuthenticationService.GenerateWebCredentials` (method 8, program `WoW`) on its authenticated connection. The response carries a 32-byte random reconnect credential. BGS stores only its SHA-256 digest, for 24 hours, with the account, peer address, program, client build and the authentication proof of the issuing session. Each connection holds at most one live credential: issuing again revokes the previous one.

A new connection presents the credential in `LogonRequest.cached_web_credentials` instead of starting a web challenge. BGS consumes it atomically, so it works once. The logon succeeds only from the same address, program and build, and only if the same IP, ban and proof checks as a web logon still pass; a password or authenticator change, a ban or an IP block revokes the credential. Any mismatch, or an unknown, expired or consumed credential, answers `OnLogonComplete` with `ERROR_NO_AUTH` and never falls back to a web challenge. The client then issues a fresh credential on the new connection.

## Why

Players stay on Battle.net through routine redeploys without the client holding their password. Binding the credential to the address, single use and the existing proof keeps a stolen credential no more useful than the authenticated session it came from, and only for one logon. The 24-hour lifetime covers a long play session; a client whose credential expired must log in again, which is the behaviour before this decision.
