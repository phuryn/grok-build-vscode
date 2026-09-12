import Cocoa
import ApplicationServices

let accessibility = AXIsProcessTrusted()
var screenRecording = false
var inputMonitoring = false

if #available(macOS 10.15, *) {
    screenRecording = CGPreflightScreenCaptureAccess()
    inputMonitoring = CGPreflightListenEventAccess()
} else {
    screenRecording = true
    inputMonitoring = accessibility
}

let finalInputMonitoring = inputMonitoring || accessibility

let result = """
{
    "accessibility": \(accessibility ? "true" : "false"),
    "screenRecording": \(screenRecording ? "true" : "false"),
    "inputMonitoring": \(finalInputMonitoring ? "true" : "false")
}
"""
print(result)
