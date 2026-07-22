# Security policy

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's
private vulnerability reporting for this repository when available, or contact
the maintainer through the GitHub profile associated with the repository.

Include the affected route or file, reproduction steps, impact, and any known
mitigations. Do not include real credentials, cookies, private book-source
collections, or personal data in reports.

## Supported version

Security fixes target the latest release on the default branch.

## Security boundaries

ORSP Converter deliberately does not execute embedded JavaScript/Java rules,
interactive login flows, CAPTCHA solvers, or browser-challenge bypasses. It
also rejects private-network fetch targets and constrains proxied cover assets
to the source origin.
