# Security

## Supported versions

Security fixes go into the latest release only. Update to it before reporting a problem, if you
can.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead: on the
repository's **Security** tab, choose **Report a vulnerability**
([direct link](https://github.com/gako-app/gako/security/advisories/new)).

Include what you can of:

- Gako's version and your system. The About window (the ⓘ button in the status bar) has a Copy
  button for both.
- What an attacker needs (a repository you open, a web page, another local user…) and what they
  get.
- Steps to reproduce, or a proof of concept.

You should hear back within a week. Gako is maintained by one person, so fixes take as long as they
take, but security problems come first. Once a fix is released, the advisory is published and
credits you, unless you'd rather it didn't.

## What Gako trusts

Gako runs as you, with your rights. Its terminals run whatever you and your agents type, and it can
read any file you can. So the questions that matter are about everyone else.

**These are vulnerabilities:**

- **Anything else driving Gako's core.** The core listens on a loopback port and accepts only
  connections that present a random token, made by the app when it starts. A web page, another
  local user, or a process that doesn't have the token must not be able to run commands, read
  files or watch terminals through it.
- **Escaping Gako's windows.** The windows load only Gako's own pages, with context isolation,
  Chromium's sandbox and a content security policy that allows only Gako's own scripts, and the
  preload scripts expose a short, fixed list of calls. Content that
  makes a window load remote content, navigate away, or reach Electron's or Node's APIs is a
  vulnerability.
- **Repository content running code.** Gako shows what's in your repositories: file names and
  contents, diffs, commit messages, branch names, and the output of programs in its terminals. None
  of it should be able to run code or commands. That includes settings: Gako reads them only from
  your own settings file, never from a folder it opens.

**These aren't:**

- What agents, or any other program, do in Gako's terminals. Gako runs them as you, as any
  terminal would.
- Attacks that need code already running as your user.
- Your operating system's warnings about an unsigned app.

**Git follows each repository's own configuration.** Gako runs `git` in every repository it finds,
as any Git tool does, and git obeys the repository's `.git/config`, which can name programs to run.
A clone doesn't bring that file along, but a copied folder or an unpacked archive can. Treat
repositories from such sources as you would in any other Git tool.
