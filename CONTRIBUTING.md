# Contributing

Thanks for helping improve ORSP Converter.

## Development

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run check
```

Keep changes focused and include tests for behavior changes. Do not commit real
book-source data, environment files, credentials, private keys, deployment
targets, or production logs.

## Pull requests

- Explain the problem and the chosen approach.
- Keep protocol behavior backward compatible unless the change is explicitly a
  versioned protocol update.
- Confirm `npm run check` passes.
- Document any compatibility or security trade-offs.

## Responsible use

Contributions must not add CAPTCHA bypasses, browser-challenge circumvention,
credential collection, or functionality intended to evade upstream access
controls. Contributors are responsible for respecting source-site terms and
applicable law.
