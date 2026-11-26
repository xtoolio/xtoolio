# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue: use **"Report a vulnerability"** under this
repository's **Security** tab (GitHub's private vulnerability reporting). Include what you found, how to reproduce it,
and what an attacker could do with it.

We read every report and will reply there. Please give us a chance to fix a problem before you disclose it publicly.

## In scope

This repository's code, and the hosted service at xtoolio.com: sign-in and sessions, CSRF, the Content Security
Policy, how X tokens are stored, access to another account's data, and anything that moves money (the prepaid
balance, Stripe top-ups and auto-refill).

## Out of scope

Reports about X's own API or platform, findings that need a compromised device or browser, rate limiting on public
pages, missing security headers that don't lead to an exploit, and social engineering.
