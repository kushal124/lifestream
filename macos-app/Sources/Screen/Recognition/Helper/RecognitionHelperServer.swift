import Darwin
import Evidence
import Foundation

public enum RecognitionHelperServer {
    public static func serve() {
        signal(SIGPIPE, SIG_IGN)
        pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0)
        serve(input: STDIN_FILENO, output: STDOUT_FILENO) { $0.recognize() }
    }

    static func serve(input: Int32, output: Int32, recognize: (TileCrop) -> [TextObservation]?) {
        while let (id, crop) = RecognitionWire.readRequest(input) {
            let text = autoreleasepool { recognize(crop) }
            guard let reply = try? RecognitionWire.reply(.init(id: id, text: text)),
                  FileDescriptors.write(output, reply) else { return }
        }
    }
}
