import Cocoa
import Carbon
import ApplicationServices

var lastTriggerTime = Date.distantPast
var leftCmdDown = false
var rightCmdDown = false

func checkPermissionsJson() -> String {
    let accessibility = AXIsProcessTrusted()
    var screenRecording = false
    var inputMonitoring = false
    
    // When run via execFile from Electron, we inherit the bundle's TCC context
    // but occasionally CGPreflight APIs return false if the specific process lacks an event loop.
    if #available(macOS 10.15, *) {
        screenRecording = CGPreflightScreenCaptureAccess()
        inputMonitoring = CGPreflightListenEventAccess()
    } else {
        screenRecording = true
        inputMonitoring = accessibility
    }
    
    let finalInputMonitoring = inputMonitoring || accessibility
    
    return "{\"accessibility\": \(accessibility), \"screenRecording\": \(screenRecording), \"inputMonitoring\": \(finalInputMonitoring)}"
}

if CommandLine.arguments.contains("--check-permissions") {
    print(checkPermissionsJson())
    fflush(stdout)
    exit(0)
}

let globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
    let keyCode = event.keyCode
    if keyCode == 55 {
        leftCmdDown = event.modifierFlags.contains(.command)
    } else if keyCode == 54 {
        rightCmdDown = event.modifierFlags.contains(.command)
    }
    
    if !event.modifierFlags.contains(.command) {
        leftCmdDown = false
        rightCmdDown = false
    }

    if leftCmdDown && rightCmdDown {
        let now = Date()
        if now.timeIntervalSince(lastTriggerTime) > 1.2 {
            lastTriggerTime = now
            print("DUAL_CMD_TRIGGER")
            fflush(stdout)
        }
    }
}

let localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
    let keyCode = event.keyCode
    if keyCode == 55 { leftCmdDown = event.modifierFlags.contains(.command) }
    else if keyCode == 54 { rightCmdDown = event.modifierFlags.contains(.command) }
    if !event.modifierFlags.contains(.command) { leftCmdDown = false; rightCmdDown = false }

    if leftCmdDown && rightCmdDown {
        let now = Date()
        if now.timeIntervalSince(lastTriggerTime) > 1.2 {
            lastTriggerTime = now
            print("DUAL_CMD_TRIGGER")
            fflush(stdout)
        }
    }
    return event
}

if globalMonitor == nil && localMonitor == nil {
    print("ERROR_FAILED_TO_INSTALL_MONITOR")
    fflush(stdout)
    exit(1)
}

print("LISTENER_READY")
fflush(stdout)

NSApplication.shared.run()
