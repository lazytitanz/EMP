# Security Policy

Security is important to the EMP project. We appreciate the efforts of security researchers, developers, and community members who help identify and responsibly disclose potential vulnerabilities.

## Supported Versions

EMP is actively developed, and security fixes are generally provided for the latest stable release.

| Version | Supported |
| ------- | --------- |
| Latest stable release | ✅ |
| Older releases | ❌ |
| Development builds | ❌ |

Older versions and development builds are not guaranteed to receive security updates. Users are encouraged to keep EMP updated to the latest stable release.

## Reporting a Vulnerability

If you discover a potential security vulnerability in EMP, **please do not report it through a public GitHub Issue or Discussion.**

Instead, use GitHub's private vulnerability reporting feature:

**[Report a Security Vulnerability](https://github.com/lazytitanz/EMP/security/advisories/new)**

This allows vulnerabilities to be reported privately so they can be investigated before details are made public.

### What to Include

When submitting a report, please provide as much relevant information as possible:

- A clear description of the vulnerability.
- The affected EMP version.
- Steps to reproduce the issue.
- The potential security impact.
- Any relevant logs, screenshots, or proof-of-concept code.
- Suggested mitigations or fixes, if available.

Please avoid including unnecessary personal or sensitive information.

## What to Expect

Security reports will be reviewed as time and resources permit.

We aim to:

1. **Acknowledge reports** within 7 days when reasonably possible.
2. **Investigate** the reported issue and determine its validity and potential impact.
3. **Communicate findings** and provide updates when meaningful progress has been made.
4. **Develop and release a fix** for confirmed vulnerabilities based on their severity and complexity.
5. **Coordinate disclosure** with the reporter when appropriate.

These are goals rather than guaranteed response or resolution deadlines. EMP is maintained on a best-effort basis, and resolution times may vary.

### Accepted Reports

If a vulnerability is confirmed, we will work toward an appropriate fix and may publish a GitHub Security Advisory to inform users.

### Declined Reports

If a report is determined not to represent a security vulnerability, we will explain the reasoning when reasonably possible.

## Responsible Disclosure

We ask security researchers to:

- Allow reasonable time for investigation and remediation before publicly disclosing vulnerabilities.
- Avoid accessing, modifying, or deleting data belonging to others.
- Avoid testing that disrupts services or negatively affects other users.
- Limit testing to systems and environments they own or are authorized to assess.
- Act in good faith and provide sufficient information to reproduce reported issues.

We appreciate responsible security research and will make reasonable efforts to acknowledge individuals who help improve EMP's security, with their permission.

## Third-Party Dependencies

EMP relies on third-party libraries and components, including .NET and WebView2.

Security issues originating in third-party dependencies may require upstream fixes or dependency updates.

If you identify a vulnerability involving a dependency that affects EMP, please report it using the same private reporting process.

## Security Updates

Confirmed security vulnerabilities may be addressed through application updates, dependency upgrades, configuration changes, or other appropriate mitigations.

Security-related releases and advisories will be published through the project's GitHub repository when appropriate.

Users should obtain EMP releases from the official repository:

https://github.com/lazytitanz/EMP/releases

---

Thank you for helping keep EMP and its community safe.
