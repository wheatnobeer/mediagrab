# Security

## Reporting a vulnerability

Please use GitHub's **Security → Report a vulnerability** (private advisory) for
this repository. Do not open a public issue for security-sensitive reports.

Include:

- extension version and Chrome version;
- a minimal reproduction;
- what data or permission boundary is affected.

## Design notes

- The extension does not upload video, cookies, browsing history, or account data.
- Network requests are made with the current browser session to the same media
  URLs the page already uses.
- No remote code is loaded; all scripts are bundled in `extension/`.
- DRM-protected media is detected and refused. The project does not implement
  DRM bypasses and will not accept contributions that do.
