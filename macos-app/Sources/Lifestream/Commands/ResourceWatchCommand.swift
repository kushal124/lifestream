import ResourceWatch

enum ResourceWatchCommand {
    static func watch(_ options: Options) -> CommandOutcome {
        let process = MacProcess.current
        ResourceWatch.run(.init(spool: options.directory, powerLog: options.powerLog, app: options.appBundle,
                                duration: options.duration, files: process.files, scratch: process.scratch))
        return .succeeded
    }
}
