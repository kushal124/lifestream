import childProcess from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import Module, { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";
import workerThreads from "node:worker_threads";

const LOADED = Symbol.for("lifestream.test-process");

if (globalThis[LOADED] !== true) {
  globalThis[LOADED] = true;

  process.env.LIFESTREAM_TEST_FREE ??= "1000000000000";
  process.env.LIFESTREAM_TEST_WALKS ??= "1";

  const self = fileURLToPath(import.meta.url);
  if (!(process.env.NODE_OPTIONS ?? "").includes(self)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${self}`.trim();

  if (process.env.LIFESTREAM_TEST_FSYNC !== "1") {
    const skip = () => {};
    const skipAsync = (_fd, callback) => process.nextTick(callback, null);
    fs.fsyncSync = skip;
    fs.fdatasyncSync = skip;
    fs.fsync = skipAsync;
    fs.fdatasync = skipAsync;
  }

  const openPromise = fsPromises.open;
  let patchedHandle = false;
  fsPromises.open = async function (...args) {
    const handle = await openPromise.apply(this, args);
    if (!patchedHandle) {
      patchedHandle = true;
      const proto = Object.getPrototypeOf(handle);
      for (const name of ["sync", "datasync"]) {
        const original = proto[name];
        if (typeof original === "function") {
          proto[name] = function () {
            return process.env.LIFESTREAM_TEST_FSYNC !== "1" ? Promise.resolve() : original.call(this);
          };
        }
      }
    }
    return handle;
  };

  const patchSqlite = (Database) => {
    if (typeof Database?.prototype?.pragma !== "function") return;
    if (Database.prototype.pragma[LOADED] === true) return;
    const pragma = Database.prototype.pragma;
    const wrapped = function (source, options) {
      if (process.env.LIFESTREAM_TEST_FSYNC !== "1") {
        if (/^\s*(?:checkpoint_)?fullfsync\s*=/iu.test(source)) return options?.simple === true ? undefined : [];
        if (/^\s*synchronous\s*=\s*(?:FULL|2)\s*$/iu.test(source)) return pragma.call(this, "synchronous = NORMAL", options);
      }
      return pragma.call(this, source, options);
    };
    wrapped[LOADED] = true;
    Database.prototype.pragma = wrapped;
  };
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const loaded = load.call(this, request, parent, isMain);
    if (typeof request === "string" && (request === "better-sqlite3" || /(?:^|[\\/])better-sqlite3(?:[\\/]lib[\\/]index\.js)?$/u.test(request))) {
      patchSqlite(loaded);
    }
    return loaded;
  };

  const statfs = fs.statfsSync;
  fs.statfsSync = function (path, options) {
    const stats = statfs.call(this, path, options);
    const stated = process.env.LIFESTREAM_TEST_FREE;
    const free = Number(/^\d+$/u.test(stated) ? stated : fs.readFileSync(stated, "utf8").trim());
    if (!Number.isSafeInteger(free)) throw new Error(`LIFESTREAM_TEST_FREE states no whole number of bytes: ${stated}`);
    stats.bavail = free / stats.bsize;
    return stats;
  };

  const LOOPBACK = new Set(["localhost", "localhost.", "::1", "::ffff:127.0.0.1", "0.0.0.0"]);
  const loopback = (host) => LOOPBACK.has(host) || (net.isIPv4(host) && host.startsWith("127."));
  const guard = (host) => {
    if (!loopback(host)) throw new Error(`a test reached ${host}: a test connects to loopback only, never to the network`);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const [first, second] = args;
    const options = Array.isArray(first) ? first[0] : typeof first === "object" && first !== null ? first
      : typeof first === "string" && !/^\d+$/u.test(first) ? { path: first } : { host: typeof second === "string" ? second : undefined };
    if (!options.path) guard(options.host || "localhost");
    return connect.apply(this, args);
  };
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (...args) {
    const address = args.slice(1).find((arg) => typeof arg === "string");
    if (address !== undefined) guard(address);
    return send.apply(this, args);
  };
  const datagramConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function (port, address, ...rest) {
    if (typeof address === "string") guard(address);
    return datagramConnect.call(this, port, address, ...rest);
  };

  const NOT_THERE = "/nonexistent/no-tailscale-of-this-machine-in-a-test/tailscale";
  const real = (place) => {
    try {
      return fs.realpathSync(place);
    } catch {
      return place;
    }
  };
  const runnable = (file) => {
    if (typeof file !== "string" || path.basename(file).toLowerCase() !== "tailscale") return file;
    const temporary = real(os.tmpdir()) + path.sep;
    return path.isAbsolute(file) && real(file).startsWith(temporary) ? file : NOT_THERE;
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = childProcess[name];
    const wrapped = function (file, ...rest) {
      return original.call(this, runnable(file), ...rest);
    };
    const promised = original[util.promisify.custom];
    if (promised !== undefined) wrapped[util.promisify.custom] = (file, ...rest) => promised(runnable(file), ...rest);
    childProcess[name] = wrapped;
  }

  workerThreads.Worker = class extends workerThreads.Worker {
    constructor(program, options = {}) {
      const execArgv = options.execArgv ?? process.execArgv;
      super(program, execArgv.some((arg) => arg.includes(self)) ? options : { ...options, execArgv: [...execArgv, `--import=${self}`] });
    }
  };

  syncBuiltinESMExports();
}
