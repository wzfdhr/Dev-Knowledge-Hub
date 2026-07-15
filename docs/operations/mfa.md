# Administrator MFA

Only a workspace administrator can enroll MFA. Enrollment requires the current password, returns a one-time Base32 TOTP secret and is inactive until a six-digit code verifies it. Successful verification returns ten recovery codes once; the service stores only scrypt hashes.

After five invalid MFA factors, the account is locked for 15 minutes. A recovery code can be used once at sign-in, but cannot bypass a lock. Enabling or disabling MFA increments the account `sessionVersion`, so all existing browser sessions require a fresh sign-in.

Disabling MFA requires the current password and a current TOTP code. Recovery codes cannot disable MFA. If the administrator loses both factors, use the documented break-glass operational procedure in the next recovery-gate task; do not create a public bypass endpoint.
