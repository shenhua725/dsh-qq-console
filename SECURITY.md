# Security

## Reporting a vulnerability

Please use GitHub Security Advisories to report security issues privately:

https://github.com/shenhua725/dsh-qq-console/security/advisories/new

Do not open a public issue for a vulnerability until it has been reviewed.

## Secrets

This repository must never contain a real AppID, AppSecret, access token, user
OpenID, or `%USERPROFILE%\.dsh\qq-console-v2\settings.json`.

AppSecret is stored locally with Windows DPAPI and is never displayed by the
plugin. If you accidentally commit a secret, revoke it in the QQ Open Platform
immediately and rewrite the Git history before publishing.
