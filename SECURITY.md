# Security

Lifestream keeps the record of one person's life on their own Mac. A hole in it can expose
everything they have: their messages, their mail, where they have been, their health, what was on
their screen. Thank you for reporting one.

## How to report

Report it privately, through GitHub: on this repository's **Security** tab, choose **Report a
vulnerability**. Only the maintainers see the report. Do not open a public issue, a pull request or
a discussion for a hole that is not fixed yet.

Say what you found, the version or commit you found it in, and the steps that show it. A proof
that uses synthetic data is best: never send anyone's real records.

## What to expect

- An answer within a week saying whether we can reproduce it.
- A fix on the main branch and in the next release, as soon as it is made; for a hole that
  exposes records, before anything else.
- Credit in the release notes, by the name you choose, unless you ask for none.
- Word from us before the hole is described in public, and a date agreed with you.

## Supported versions

The latest release of the Mac app, the iPhone app and the Chrome extension, and the main branch.
The Mac app checks for an update every hour and installs it by itself, so a fix reaches every Mac
with its next release.

## What Lifestream defends against

The words below are the code's. The **home** is the Lifestream process on the person's Mac that
keeps their data in one folder. The **door** is the home's HTTP server, which devices and readers
reach. A **pass** is the secret a paired device or an agent sends with each request. The
**tailnet** is the person's own Tailscale network.

Lifestream defends a person's record against:

- **another account on the same Mac**, which must read nothing of the home's files, its logs or
  its servers' answers;
- **a stolen Mac or disk**, which must yield nothing of an encrypted home's folder, and no
  credential the vault seals in a home that is not encrypted;
- **a web page in the person's own browser**, which must reach nothing on the Mac's local
  servers: the door, the dashboard, the MCP server;
- **another machine on the person's Wi-Fi or tailnet**, which must reach nothing without a pass,
  and must not stop the person's own devices from pairing. The door answers on every network the
  Mac joins over TLS, and over plain HTTP only on loopback and the tailnet; the MCP server answers
  on every network on port 4681, over plain HTTP, behind a pass;
- **anyone on the internet**, while Lifestream's internet address is on (an agent's guide turns it on): Tailscale Funnel then
  puts the MCP server's `/mcp`, its skill and its OAuth sign-in routes on a public address, and
  nothing else. While it is off the Funnel is removed and that address answers nothing. A sign-in must not succeed without the person's approval on their Mac or iPhone;
- **someone holding the person's unlocked phone**, who must not widen what the phone may already
  read. The phone's pass may turn the internet address on, which lets nothing read without a yes
  or a key, and may make one kind of key, Instinct's, the one guide the phone shows whole; that key
  outlives the pass and is listed in Agents, made on the phone. The phone asks Face ID or the
  passcode before it makes a key, as before a yes.

A program that runs as the person on their own Mac is trusted: it can read their files anyway. A
report that needs one is still welcome when it reaches more than the person's own account could.

Out of scope: a provider's own service (Google, Apple, WhatsApp and the rest), the person's
Tailscale account, and denial of service that needs more than one request a second from many
machines.

The same model, in the words a person who uses Lifestream reads, is on
[How Lifestream keeps your data safe](./docs/user/keep-your-data-safe.md). What leaves the Mac on
purpose, and to whom, is on [What leaves your Mac](./docs/user/what-leaves-your-mac.md).
