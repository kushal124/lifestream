import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { addingOf, BLOCK, checkCommand, commandFile, commandHost, envOf, FISH, holdsBin, installCommand, removedCommand, type CommandHost } from "./command.js";
import { machine } from "./machine.js";
import { uninstall } from "./uninstall.js";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene(shell: string | null, env: (user: string) => string | null) {
  const user = mkdtempSync(join(tmpdir(), "ls-cmd-user-"));
  const dir = mkdtempSync(join(tmpdir(), "ls-cmd-machine-"));
  temps.push(user, dir);
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ tailscale: join(dir, "no-tailscale") }));
  const asked: string[] = [];
  const host: CommandHost = {
    machine: { dir, user },
    shell,
    env: (path) => {
      asked.push(path);
      return env(user);
    },
  };
  const link = join(user, ".local", "bin", "lifestream");
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return { user, dir, host, asked, link, read };
}

const listing = (path: string, more = "") => `Last login: Mon Nov  2 09:00:00 on ttys000\nHOME=/nowhere\nPATH=${path}\n${more}TERM=dumb\n`;
const SYSTEM = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

describe("lifestream command", () => {
  it("reads the PATH a zsh, a bash and a fish print the same, ~/.local/bin found however it is spelled", () => {
    for (const shell of ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"]) {
      const { host, user, link, read } = scene(shell, (home) => listing(`/opt/homebrew/bin:${home}/.local/bin/:${SYSTEM}`));
      const answer = installCommand(host);
      expect([answer.state, readlinkSync(link), answer.words], shell).toEqual(["installed", commandFile(host.machine.dir), "lifestream works in new terminal windows."]);
      for (const file of [".zprofile", ".zshrc", ".bash_profile", ".profile", ".config/fish/conf.d/lifestream.fish"]) expect(read(join(user, file)), `${shell} ${file}`).toBeNull();
    }
    const user = "/Users/person-a";
    expect([holdsBin(`~/.local/bin:${SYSTEM}`, user), holdsBin(`${user}/.local/bin`, user), holdsBin(SYSTEM, user), holdsBin(`${user}/.local/binx`, user)]).toEqual([true, true, false, false]);
    expect(envOf(listing(SYSTEM, "ZDOTDIR=/z\n")).get("ZDOTDIR")).toBe("/z");
  });

  it("writes one marked block to .zprofile and .zshrc for zsh, and none again", () => {
    const { host, user, read } = scene("/bin/zsh", () => listing(SYSTEM));
    writeFileSync(join(user, ".zshrc"), "alias ll='ls -l'");
    const answer = installCommand(host);
    expect(read(join(user, ".zprofile"))).toBe(BLOCK);
    expect(read(join(user, ".zshrc"))).toBe(`alias ll='ls -l'\n${BLOCK}`);
    expect(answer).toEqual({ state: "installed", link: "~/.local/bin/lifestream", words: "lifestream works in new terminal windows.", did: expect.any(Array), prompt: expect.any(String) });
    const again = installCommand(host);
    expect([read(join(user, ".zprofile")), read(join(user, ".zshrc")), again.did]).toEqual([BLOCK, `alias ll='ls -l'\n${BLOCK}`, []]);
  });

  it("writes zsh's block where its ZDOTDIR says, and bash's in the file a login bash reads", () => {
    const zsh = scene("/bin/zsh", (home) => listing(SYSTEM, `ZDOTDIR=${home}/.config/zsh\n`));
    installCommand(zsh.host);
    expect([zsh.read(join(zsh.user, ".config/zsh/.zprofile")), zsh.read(join(zsh.user, ".config/zsh/.zshrc")), zsh.read(join(zsh.user, ".zprofile"))]).toEqual([BLOCK, BLOCK, null]);

    const fresh = scene("/bin/bash", () => listing(SYSTEM));
    installCommand(fresh.host);
    expect(fresh.read(join(fresh.user, ".bash_profile"))).toBe(BLOCK);
    const profiled = scene("/bin/bash", () => listing(SYSTEM));
    writeFileSync(join(profiled.user, ".profile"), "export EDITOR=vi\n");
    installCommand(profiled.host);
    expect([profiled.read(join(profiled.user, ".profile")), profiled.read(join(profiled.user, ".bash_profile"))]).toEqual([`export EDITOR=vi\n${BLOCK}`, null]);
  });

  it("writes fish a file of its own, and none again", () => {
    const { host, user, read } = scene("/opt/homebrew/bin/fish", () => listing(SYSTEM));
    installCommand(host);
    const file = join(user, ".config", "fish", "conf.d", "lifestream.fish");
    expect([read(file), read(join(user, ".zprofile"))]).toEqual([FISH, null]);
    expect(installCommand(host).did).toEqual([]);
  });

  it("writes nothing for another shell, guesses it no line, and names the command's whole path; writes a block when the shell cannot be read", () => {
    for (const shell of ["/bin/tcsh", "/bin/ksh"]) {
      const { host, user, link } = scene(shell, () => listing(SYSTEM));
      const answer = installCommand(host);
      expect([Object.keys(answer).sort(), answer.state, lstatSync(link).isSymbolicLink()], shell).toEqual([["did", "link", "prompt", "state", "words"], "installed", true]);
      expect(answer.words, shell).toBe(`lifestream is in ~/.local/bin, and Lifestream sets up PATH only for zsh, bash and fish: run it as ${link}, or add ~/.local/bin to your shell's PATH yourself.`);
      for (const file of [".zprofile", ".zshrc", ".bash_profile", ".profile", ".cshrc", ".tcshrc", ".kshrc"]) expect(existsSync(join(user, file)), `${shell} ${file}`).toBe(false);
    }
    const silent = scene("/bin/zsh", () => null);
    const unread = installCommand(silent.host);
    expect([silent.read(join(silent.user, ".zprofile")), unread.did.at(-1)]).toEqual([BLOCK, "zsh did not print its PATH within 5 seconds, so its startup files have the PATH line"]);
  });

  it("leaves another program at ~/.local/bin/lifestream alone, says so, and puts no PATH line in for it", () => {
    const { host, user, link, read, asked } = scene("/bin/zsh", () => listing(SYSTEM));
    mkdirSync(join(user, ".local", "bin"), { recursive: true });
    writeFileSync(link, "#!/bin/sh\necho another\n");
    const answer = installCommand(host);
    expect([answer.state, answer.words, read(link), read(join(user, ".zprofile")), asked]).toEqual(["blocked", "Another program named lifestream is in ~/.local/bin. Lifestream left it alone.", "#!/bin/sh\necho another\n", null, []]);
    expect(answer.prompt).toContain(`"`);
    rmSync(link);
    symlinkSync("/usr/bin/true", link);
    expect(installCommand(host).state).toBe("blocked");
    removedCommand(host);
    expect(readlinkSync(link)).toBe("/usr/bin/true");
  });

  it("never writes again a block or a file the person deleted, and bare command makes again only its own missing link", () => {
    const zsh = scene("/bin/zsh", () => listing(SYSTEM));
    installCommand(zsh.host);
    writeFileSync(join(zsh.user, ".zshrc"), "# mine\n");
    expect(checkCommand(zsh.host).did).toEqual([]);
    installCommand(zsh.host);
    expect([zsh.read(join(zsh.user, ".zshrc")), zsh.read(join(zsh.user, ".zprofile"))]).toEqual(["# mine\n", BLOCK]);

    const fish = scene("/opt/homebrew/bin/fish", () => listing(SYSTEM));
    installCommand(fish.host);
    const file = join(fish.user, ".config", "fish", "conf.d", "lifestream.fish");
    rmSync(file);
    installCommand(fish.host);
    expect(existsSync(file)).toBe(false);

    rmSync(zsh.link);
    const before = [zsh.read(join(zsh.user, ".zshrc")), zsh.read(join(zsh.user, ".zprofile"))];
    const repaired = checkCommand(zsh.host);
    expect([repaired.state, readlinkSync(zsh.link), repaired.did, [zsh.read(join(zsh.user, ".zshrc")), zsh.read(join(zsh.user, ".zprofile"))]])
      .toEqual(["installed", commandFile(zsh.dir), ["linked ~/.local/bin/lifestream again"], before]);
    const never = scene("/bin/zsh", () => listing(SYSTEM));
    expect([checkCommand(never.host).state, existsSync(never.link)]).toEqual(["absent", false]);
    removedCommand(zsh.host);
    expect([checkCommand(zsh.host).state, existsSync(zsh.link)]).toEqual(["absent", false]);
  });

  it("leaves a fish file the person edited on remove, and says so", () => {
    const { host, user } = scene("/opt/homebrew/bin/fish", () => listing(SYSTEM));
    installCommand(host);
    const file = join(user, ".config", "fish", "conf.d", "lifestream.fish");
    writeFileSync(file, `${FISH}set -gx EDITOR vi\n`);
    const answer = removedCommand(host);
    expect([readFileSync(file, "utf8"), answer.did]).toEqual([`${FISH}set -gx EDITOR vi\n`, [
      "removed ~/.local/bin/lifestream",
      "~/.config/fish/conf.d/lifestream.fish changed after Lifestream wrote it, so it stays: delete it yourself once you no longer want it.",
    ]]);
  });

  it("leaves each shell's files as they were, byte for byte, and no link, after remove and after uninstall", async () => {
    const cases: [string, Record<string, string>][] = [
      ["/bin/zsh", { ".zshrc": "export A=1" }],
      ["/bin/zsh", { ".zprofile": "eval x\n", ".zshrc": "" }],
      ["/bin/bash", {}],
      ["/bin/bash", { ".bash_profile": "source ~/.bashrc" }],
      ["/opt/homebrew/bin/fish", {}],
    ];
    for (const undo of ["remove", "uninstall"] as const) {
      for (const [shell, files] of cases) {
        const { host, user, dir, link } = scene(shell, () => listing(SYSTEM));
        for (const [name, text] of Object.entries(files)) writeFileSync(join(user, name), text);
        installCommand(host);
        const after = shell === "/bin/zsh" && files[".zprofile"] !== undefined;
        if (after) writeFileSync(join(user, ".zprofile"), `${readFileSync(join(user, ".zprofile"), "utf8")}export B=2\n`);
        if (undo === "remove") removedCommand(host);
        else {
          const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir }, home: user });
          const done = await uninstall(at, { restart: () => false, holds: () => false }, false);
          expect(done.command, `${shell} ${undo}`).toContain("removed ~/.local/bin/lifestream");
        }
        const expected: Record<string, string | null> = {
          ".zprofile": shell === "/bin/zsh" ? (after ? "eval x\nexport B=2\n" : files[".zprofile"] ?? null) : null,
          ".zshrc": shell === "/bin/zsh" ? files[".zshrc"]! : null,
          ".bash_profile": shell === "/bin/bash" ? files[".bash_profile"] ?? null : null,
          ".config/fish/conf.d/lifestream.fish": null,
        };
        const held = Object.fromEntries(Object.keys(expected).map((name) => [name, existsSync(join(user, name)) ? readFileSync(join(user, name), "utf8") : null]));
        expect([held, existsSync(link)], `${shell} ${JSON.stringify(files)} ${undo}`).toEqual([expected, false]);
      }
    }
  });

  it.skipIf(!existsSync("/bin/zsh"))("asks zsh itself where its startup files are: a .zshenv's ZDOTDIR, not exported, too", () => {
    const { host, user, read } = scene("/bin/zsh", () => null);
    writeFileSync(join(user, ".zshenv"), `ZDOTDIR="$HOME/.config/zsh"\n`);
    installCommand({ ...commandHost(host.machine), shell: "/bin/zsh" });
    expect([read(join(user, ".config/zsh/.zprofile")), read(join(user, ".config/zsh/.zshrc")), read(join(user, ".zprofile")), read(join(user, ".zshrc"))]).toEqual([BLOCK, BLOCK, null, null]);
  });

  it("undoes exactly an install that failed part way, or was cut between its record and its edit, and a remove cut part way", () => {
    const failed = scene("/bin/zsh", () => listing(SYSTEM));
    mkdirSync(join(failed.user, ".zshrc"));
    const answer = installCommand(failed.host);
    expect([failed.read(join(failed.user, ".zprofile")), answer.did.at(-1)]).toEqual([BLOCK, expect.stringMatching(/^could not add the PATH line to ~\/\.zshrc: /u)]);
    removedCommand(failed.host);
    expect([existsSync(join(failed.user, ".zprofile")), lstatSync(join(failed.user, ".zshrc")).isDirectory()]).toEqual([false, true]);
    for (const cut of ["install", "remove"] as const) {
      const { host, user, dir, read } = scene("/bin/zsh", () => listing(SYSTEM));
      writeFileSync(join(user, ".zshrc"), "export A=1\n");
      installCommand(host);
      const record = JSON.parse(readFileSync(join(dir, "command.json"), "utf8")) as { wrote: object[] };
      if (cut === "install") writeFileSync(join(user, ".zshrc"), "export A=1\n");
      else rmSync(join(user, ".zprofile"));
      writeFileSync(join(dir, "command.json"), JSON.stringify({ ...record, wrote: record.wrote.map((wrote) => ({ ...wrote, pending: true })) }));
      installCommand(host);
      expect([read(join(user, ".zprofile")), read(join(user, ".zshrc"))], cut).toEqual([BLOCK, `export A=1\n${BLOCK}`]);
      removedCommand(host);
      removedCommand(host);
      expect([read(join(user, ".zprofile")), read(join(user, ".zshrc"))], cut).toEqual([null, "export A=1\n"]);
    }
  });

  it("rewrites a linked shell file at its target, keeps the link and each file's mode, and leaves nothing beside them", () => {
    const { host, user } = scene("/bin/zsh", () => listing(SYSTEM));
    const dotfiles = join(user, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "zshrc"), "export A=1\n");
    chmodSync(join(dotfiles, "zshrc"), 0o600);
    symlinkSync(join("dotfiles", "zshrc"), join(user, ".zshrc"));
    writeFileSync(join(user, ".zprofile"), "eval x\n");
    chmodSync(join(user, ".zprofile"), 0o640);
    const held = () => ({
      link: lstatSync(join(user, ".zshrc")).isSymbolicLink() ? readlinkSync(join(user, ".zshrc")) : null,
      zshrc: readFileSync(join(dotfiles, "zshrc"), "utf8"),
      zshrcMode: statSync(join(dotfiles, "zshrc")).mode & 0o7777,
      zprofile: readFileSync(join(user, ".zprofile"), "utf8"),
      zprofileMode: statSync(join(user, ".zprofile")).mode & 0o7777,
      beside: [...readdirSync(user), ...readdirSync(dotfiles)].filter((name) => name.endsWith(".tmp")),
    });
    installCommand(host);
    expect(held()).toEqual({ link: join("dotfiles", "zshrc"), zshrc: `export A=1\n${BLOCK}`, zshrcMode: 0o600, zprofile: `eval x\n${BLOCK}`, zprofileMode: 0o640, beside: [] });
    removedCommand(host);
    expect(held()).toEqual({ link: join("dotfiles", "zshrc"), zshrc: "export A=1\n", zshrcMode: 0o600, zprofile: "eval x\n", zprofileMode: 0o640, beside: [] });
  });

  it("restores a shell file that is not UTF-8 byte for byte, and takes away a file it made that holds nothing else", () => {
    const { host, user } = scene("/bin/zsh", () => listing(SYSTEM));
    const bytes = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\nPROMPT=$'\x1b[1m'"), Buffer.from([0xff, 0xfe])]);
    writeFileSync(join(user, ".zshrc"), bytes);
    installCommand(host);
    removedCommand(host);
    expect([readFileSync(join(user, ".zshrc")).equals(bytes), existsSync(join(user, ".zprofile"))]).toEqual([true, false]);
    const bash = scene("/bin/bash", () => listing(SYSTEM));
    installCommand(bash.host);
    removedCommand(bash.host);
    expect(existsSync(join(bash.user, ".bash_profile"))).toBe(false);
  });

  it("names ~/.local/bin/lifestream in the agent's prompt with Lifestream's link there, else the whole path, quoted", () => {
    const { host, dir, user, link } = scene("/bin/zsh", (home) => listing(`${home}/.local/bin:${SYSTEM}`));
    const blank = (line: string) => /^Lifestream runs on this Mac\. Run (.+) help connectors and follow it to add a connector for ___; type each lifestream command it names as \1\.$/u.exec(line)?.[1];
    const whole = `"${join(dir, "current", "bin", "lifestream").replace(/["\\$`]/gu, "\\$&")}"`;
    expect([blank(addingOf(dir, user).prompt), addingOf(dir, user).blank]).toEqual([whole, "___"]);
    expect(blank(installCommand(host).prompt)).toBe("~/.local/bin/lifestream");
    expect(blank(addingOf(dir, user).prompt)).toBe("~/.local/bin/lifestream");
    rmSync(link);
    expect(blank(addingOf(dir, user).prompt)).toBe(whole);
    writeFileSync(link, "another");
    expect(blank(addingOf(dir, user).prompt)).toBe(whole);
    expect(blank(addingOf(dir, join(dir, "..")).prompt)).toBe(`"$HOME/${join(dir.split("/").at(-1)!, "current", "bin", "lifestream")}"`);
  });

  it("prints the lines and the row's words without --json, and the answer alone with it", async () => {
    const { dir, user } = scene(null, () => null);
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir }, home: user });
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const status = await runCli(args, { machine: at, shell: { shell: "/bin/zsh", env: () => listing(SYSTEM) }, write: (text) => out.push(text) });
      return { status, lines: out.join("").trimEnd().split("\n") };
    };
    const said = await run("command", "install");
    expect(said.status).toBe(0);
    expect(said.lines.filter((line) => line.startsWith("{"))).toEqual([]);
    expect(said.lines.at(-1)).toBe("lifestream works in new terminal windows.");
    const json = await run("command", "--json");
    expect([json.status, json.lines.length, JSON.parse(json.lines[0]!)]).toEqual([0, 1, expect.objectContaining({ state: "installed", link: "~/.local/bin/lifestream", did: [] })]);
    expect(await run("command", "add")).toEqual({ status: 1, lines: ["command takes install or remove", "usage: lifestream command [install | remove]"] });
    expect((await run("command", "remove", "--json")).lines.map((line) => (JSON.parse(line) as { state: string }).state)).toEqual(["absent"]);
  });
});
