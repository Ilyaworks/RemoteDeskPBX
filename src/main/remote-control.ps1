# RemoteDeskPBX control script
# Runs continuously, reads commands from stdin
# Commands: mouse-move X Y | mouse-down | mouse-up | mouse-scroll DELTA | key-press KEYCODE

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
"@

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Split(' ')
    $cmd = $parts[0]
    
    switch ($cmd) {
        "mm" {  # mouse-move
            [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$parts[1], [int]$parts[2])
        }
        "md" {  # mouse-down
            if ($parts[1] -eq "2") { [WinAPI]::mouse_event(0x0008,0,0,0,0) } else { [WinAPI]::mouse_event(0x0002,0,0,0,0) }
        }
        "mu" {  # mouse-up
            if ($parts[1] -eq "2") { [WinAPI]::mouse_event(0x0010,0,0,0,0) } else { [WinAPI]::mouse_event(0x0004,0,0,0,0) }
        }
        "ms" {  # mouse-scroll
            [WinAPI]::mouse_event(0x0800,0,0,([int]$parts[1] * 120),0)
        }
        "kp" {  # key-press
            [WinAPI]::keybd_event([byte][int]$parts[1],0,0,0)
            Start-Sleep -Milliseconds 10
            [WinAPI]::keybd_event([byte][int]$parts[1],0,2,0)
        }
    }
}