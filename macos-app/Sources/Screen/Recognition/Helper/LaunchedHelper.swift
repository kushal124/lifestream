import Darwin
import Evidence
import Foundation

final class LaunchedHelper: HelperProcess, @unchecked Sendable {
    let pid: pid_t
    private let requests: Int32
    private let replies: Int32
    private let lock = NSLock()
    private var ended = false
    private var last: ProcessUsage?

    init?(executable: String) {
        var toHelper: [Int32] = [-1, -1], fromHelper: [Int32] = [-1, -1]
        guard pipe(&toHelper) == 0 else { return nil }
        guard pipe(&fromHelper) == 0 else {
            toHelper.forEach { close($0) }
            return nil
        }
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawnattr_init(&attributes)
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
        }
        posix_spawn_file_actions_adddup2(&actions, toHelper[0], STDIN_FILENO)
        posix_spawn_file_actions_adddup2(&actions, fromHelper[1], STDOUT_FILENO)
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_set_qos_class_np(&attributes, QOS_CLASS_UTILITY)
        var child: pid_t = 0
        let arguments = [executable, "ocr-helper"]
        let argv = arguments.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        let spawned = posix_spawn(&child, executable, &actions, &attributes, argv, environ)
        close(toHelper[0])
        close(fromHelper[1])
        guard spawned == 0 else {
            close(toHelper[1])
            close(fromHelper[0])
            return nil
        }
        pid = child
        requests = toHelper[1]
        replies = fromHelper[0]
        _ = fcntl(requests, F_SETNOSIGPIPE, 1)
    }

    deinit {
        end()
        close(requests)
        close(replies)
    }

    func exchange(_ request: Data) -> RecognitionWire.Reply? {
        guard !isEnded, FileDescriptors.write(requests, request) else { return nil }
        return RecognitionWire.readReply(replies)
    }

    func setBackground(_ background: Bool) {
        lock.withLock {
            guard !ended else { return }
            _ = setpriority(PRIO_DARWIN_PROCESS, id_t(pid), background ? PRIO_DARWIN_BG : 0)
        }
    }

    func end() {
        let pid = lock.withLock { () -> pid_t? in
            guard !ended else { return nil }
            ended = true
            last = ProcessUsage.read(pid: self.pid)
            kill(self.pid, SIGKILL)
            return self.pid
        }
        guard let pid else { return }
        DispatchQueue.global(qos: .utility).async {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
        }
    }

    func usage() -> ProcessUsage? {
        lock.withLock { ended ? last : ProcessUsage.read(pid: pid) }
    }

    private var isEnded: Bool { lock.withLock { ended } }
}
