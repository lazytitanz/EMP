# Contributing to EMP

First off, thank you for your interest in contributing to EMP!

EMP is an open-source Windows music player designed to bring a modern, streaming-style experience to the music you already own. Whether you're fixing a bug, suggesting a feature, improving documentation, or contributing code, your involvement is appreciated.

You don't need to be an experienced developer to contribute. Thoughtful feedback and detailed bug reports are just as valuable as code.

## Ways to Contribute

There are several ways you can help improve EMP:

- **Report bugs:** Help identify issues and unexpected behavior.
- **Suggest features:** Share ideas that could improve the listening experience.
- **Contribute code:** Fix bugs, improve performance, or implement features.
- **Improve documentation:** Fix mistakes, clarify instructions, or add useful information.
- **Test changes:** Help verify fixes and identify regressions.
- **Participate in discussions:** Share feedback and help other community members.

Every contribution matters, regardless of size.

## Before You Begin

Before opening an issue or submitting a pull request:

1. Check existing [Issues](https://github.com/lazytitanz/EMP/issues) to see whether the topic has already been reported.
2. Review open [Pull Requests](https://github.com/lazytitanz/EMP/pulls) to avoid duplicating ongoing work.
3. For significant changes or new features, consider starting a [Discussion](https://github.com/lazytitanz/EMP/discussions) first.
4. Familiarize yourself with the project's existing structure and conventions.

For small bug fixes, documentation improvements, and straightforward changes, you're welcome to submit a pull request directly.

For larger features or architectural changes, discussing your approach beforehand can save everyone time.

## Reporting Bugs

Bug reports help make EMP more reliable.

When submitting a bug report, please include as much relevant information as possible.

### What to Include

- **Description:** A clear explanation of the problem.
- **Steps to reproduce:** Instructions that allow someone else to reproduce the issue.
- **Expected behavior:** What you expected EMP to do.
- **Actual behavior:** What happened instead.
- **EMP version:** The version you're running.
- **Windows version:** Your operating system version.
- **Screenshots or logs:** If applicable.

For audio-related issues, additional details such as the audio format, output device, and relevant playback settings can be especially helpful.

### Example Bug Report

**Title:** Playback stops when skipping certain FLAC tracks

**Description:**
When skipping between FLAC files, playback occasionally stops instead of advancing to the next track.

**Steps to reproduce:**
1. Add a folder containing FLAC files.
2. Start playing an album.
3. Skip through several tracks.
4. Observe that playback occasionally stops.

**Expected behavior:**
Playback should continue to the selected track.

**Actual behavior:**
Playback stops and must be restarted manually.

**Environment:**
- EMP version: 0.x.x
- Windows version: Windows 11
- Audio format: FLAC

Please avoid including private information, copyrighted music files you do not have permission to share, or sensitive system information in public reports.

For potential security vulnerabilities, avoid publishing exploit details in a public issue. Contact the maintainer privately instead.

## Suggesting Features

Feature suggestions are welcome!

EMP aims to provide a polished experience for local music libraries without requiring a streaming subscription or account.

When proposing a feature, explain:

- What problem the feature would solve.
- How you envision it working.
- Why it would benefit EMP users.
- Any alternatives you've considered.

Screenshots, mockups, and examples from other applications are welcome when they help explain your idea.

Please understand that not every suggestion will be implemented. Features are evaluated based on project goals, complexity, maintainability, and development priorities.

## Development Setup

### Requirements

To build and run EMP locally, you'll need:

- Windows 10 or later.
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- Git.
- A suitable development environment, such as Visual Studio, Visual Studio Code, or another C#-compatible editor.

### Clone the Repository

```bash
git clone https://github.com/lazytitanz/EMP.git
cd EMP
```

### Build EMP

```bash
dotnet restore EMP.slnx
dotnet build EMP.slnx
```

### Run EMP

```bash
dotnet run --project EMP
```

### Run Tests

EMP includes test projects for the application and updater components.

Run the test suite with:

```bash
dotnet test EMP.slnx
```

Some tests may depend on Windows-specific functionality or environmental conditions.

Before submitting changes, run the relevant tests and verify that the application builds successfully.

## Project Structure

EMP is a Windows desktop application built using C#, .NET, WinForms, and WebView2.

The repository includes the following main components:

| Directory | Purpose |
|---|---|
| `EMP/` | Main desktop application |
| `EMP.Tests/` | Application tests |
| `EMP.UpdateCore/` | Shared update functionality |
| `EMP.Updater/` | Application updater |
| `EMP.Updater.Tests/` | Updater tests |

The main application uses WebView2 to provide its interface, combining web technologies with native Windows functionality.

Contributors should familiarize themselves with the relevant components before making changes.

## Code Contributions

We want to keep EMP maintainable, reliable, and consistent as the project grows.

### General Guidelines

- Follow the existing coding style and project conventions.
- Keep changes focused on a specific issue or improvement.
- Prefer clear, readable code over unnecessary complexity.
- Avoid introducing dependencies unless they provide a meaningful benefit.
- Handle errors gracefully and avoid silent failures.
- Preserve compatibility with supported Windows versions.
- Consider performance, especially during library scanning, playback, and UI interactions.
- Avoid unrelated refactoring in pull requests.
- Add or update tests when appropriate.

There is no need to rewrite existing code simply to match personal preferences.

### User Interface Contributions

EMP aims to provide a clean, modern, and consistent listening experience.

When contributing UI changes:

- Follow existing visual patterns, spacing, typography, and component styles.
- Maintain consistency between pages and dialogs.
- Consider different window sizes and display scaling.
- Preserve keyboard navigation and accessibility.
- Provide meaningful loading, empty, and error states.
- Avoid unnecessary animations or distracting visual effects.
- Ensure changes work correctly within WebView2.

Large visual redesigns should be discussed before implementation.

### Playback and Audio Changes

Audio reliability is a priority for EMP.

Changes affecting playback should be tested carefully, including where relevant:

- Playing, pausing, stopping, and seeking.
- Skipping tracks and queue transitions.
- Shuffle and repeat behavior.
- Gapless playback and crossfade.
- Different supported audio formats.
- Output device changes.
- Playback state and UI synchronization.

Avoid changes that introduce audible interruptions, resource leaks, or unexpected playback behavior.

### Dependencies

Please avoid adding new libraries or packages without a clear reason.

When proposing a dependency, consider its:

- Maintenance and reliability.
- License compatibility.
- Security implications.
- Impact on application size and performance.
- Necessity compared with existing functionality.

Dependencies should solve a meaningful problem rather than add complexity.

## Submitting a Pull Request

Ready to contribute code? Great!

### 1. Fork the Repository

Create a fork of [EMP](https://github.com/lazytitanz/EMP) on GitHub.

### 2. Create a Branch

Create a descriptive branch for your changes.

```bash
git checkout -b fix/playback-queue
```

Other examples:

- `feature/keyboard-shortcuts`
- `fix/library-scanning`
- `docs/update-readme`

### 3. Make Your Changes

Keep commits focused and use clear commit messages.

For example:

```text
Fix queue not advancing after track completion
```

### 4. Test Your Changes

Before submitting:

- Ensure the project builds successfully.
- Run relevant automated tests.
- Manually verify the affected functionality.
- Check for unintended changes or regressions.
- Remove debugging code and temporary files.

### 5. Open a Pull Request

Submit your pull request against the `main` branch.

Include:

- A summary of what changed.
- The reason for the change.
- Any related issue numbers.
- How you tested the changes.
- Screenshots or recordings for visible UI changes, when appropriate.

Use GitHub's `Closes #123` syntax when your pull request resolves an existing issue.

### Pull Request Review

Pull requests may receive feedback or requests for changes.

Please be open to discussion and review. Feedback is intended to improve the contribution and maintain project quality.

Not every pull request will be merged. Changes may be declined due to project scope, technical concerns, maintenance requirements, or conflicts with existing development plans.

## Documentation Contributions

Documentation improvements are always welcome.

This includes:

- Correcting spelling or formatting mistakes.
- Clarifying setup and build instructions.
- Documenting features and settings.
- Improving troubleshooting information.
- Updating outdated instructions.

Documentation should be clear, accurate, and approachable for users with different levels of technical experience.

## Licensing and Third-Party Content

By submitting a contribution, you agree that your contribution may be distributed under the repository's applicable license terms.

Only submit code, documentation, images, or other materials that you have the right to contribute.

If your contribution includes third-party material:

- Verify that its license permits the intended use and distribution.
- Preserve required copyright notices and attribution.
- Clearly identify the source and license in your pull request.
- Discuss any licensing uncertainty with the maintainer before submitting.

Do not submit proprietary code, copyrighted assets, or other materials without appropriate permission.

## Community Standards

All contributors are expected to follow EMP's [Code of Conduct](CODE_OF_CONDUCT.md).

We encourage respectful discussions, constructive criticism, and collaboration.

Disagreements about implementation details or project direction are normal, but personal attacks, harassment, and disruptive behavior are not acceptable.

## Questions and Discussions

Not sure where to start? Have a question about how something works?

You're welcome to use [GitHub Discussions](https://github.com/lazytitanz/EMP/discussions) to ask questions, share ideas, or discuss potential contributions.

If you're looking for something to work on, browse the [open issues](https://github.com/lazytitanz/EMP/issues).

## Thank You!

EMP is built around a simple idea: enjoying your own music library should feel as polished and convenient as using a modern streaming service.

Whether you contribute a single bug fix, improve documentation, or help develop a major feature, your efforts help move that goal forward.

**Thank you for helping make EMP better!**
