# P12 Windows Final Acceptance — Operator Note

This is the **single consolidated authenticity gate** for Development Group V1 after P12 is merged into `integration/development-group-v1`.

Do not run P02–P11 development work again. Do not treat Linux/web static checks as Windows acceptance.

## Required checkout

Use the exact post-merge integration SHA supplied by the P12 merge result.

```powershell
git fetch origin
git checkout integration/development-group-v1
git reset --hard <EXACT_INTEGRATION_SHA>
git clean -ffd
```

The acceptance runner itself will refuse a dirty root and will verify `ZERO3_EXPECTED_SHA` when supplied.

## One command

```powershell
$env:ZERO3_EXPECTED_SHA = '<EXACT_INTEGRATION_SHA>'
npm --prefix apps/zero3-desktop run acceptance:dg:win
```

## Required final stdout markers

A successful run must end with all of:

```text
DEVELOPMENT_GROUP_CLOSEOUT=PASS
CANDIDATE_SHA=<EXACT_INTEGRATION_SHA>
REPORT=<path>
INSTALLER=<path-to-Zero3Pilot-installer.exe>
INSTALLER_SHA256=<64-hex-sha256>
```

The machine-readable report defaults to:

```text
%TEMP%\zero3-pilot-development-group-closeout.json
```

## Fail-closed rule

Any failed step means P12 Windows acceptance is **FAIL**. Do not manually change a failing step to PASS and do not promote the integration candidate to `main` until the failure is repaired and the **whole one-shot command** passes again on the repaired exact SHA.

`OutcomeUnknown` is not an automatic retry condition.
